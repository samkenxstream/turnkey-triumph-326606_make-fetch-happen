const { Request, Response } = require('minipass-fetch')
const Minipass = require('minipass')
const MinipassCollect = require('minipass-collect')
const MinipassFlush = require('minipass-flush')
const MinipassPipeline = require('minipass-pipeline')
const cacache = require('cacache')
const url = require('url')

const CachePolicy = require('./policy.js')
const cacheKey = require('./key.js')
const remote = require('../remote.js')

// maximum amount of data we will buffer into memory
// if we'll exceed this, we switch to streaming
const MAX_MEM_SIZE = 5 * 1024 * 1024 // 5MB

// allow list for request headers that will be written to the cache index
// note: we will also store any request headers
// that are named in a response's vary header
const KEEP_REQUEST_HEADERS = [
  'accept-charset',
  'accept-encoding',
  'accept-language',
  'accept',
  'cache-control',
]

// allow list for response headers that will be written to the cache index
// note: we must not store the real response's age header, or when we load
// a cache policy based on the metadata it will think the cached response
// is always stale
const KEEP_RESPONSE_HEADERS = [
  'cache-control',
  'content-encoding',
  'content-language',
  'content-type',
  'date',
  'etag',
  'expires',
  'last-modified',
  'location',
  'pragma',
  'vary',
]

// symbols used to hide objects that may be lazily evaluated in a getter
const _request = Symbol('request')
const _response = Symbol('response')
const _policy = Symbol('policy')

class CacheEntry {
  constructor ({ entry, request, response, options }) {
    this.entry = entry
    this.options = options
    this.key = entry ? entry.key : cacheKey(request)

    // these properties are behind getters that lazily evaluate
    this[_request] = request
    this[_response] = response
    this[_policy] = null
  }

  // returns a CacheEntry instance that satisfies the given request
  // or undefined if no existing entry satisfies
  static async find (request, options) {
    try {
      // compacts the index and returns an array of unique entries
      var matches = await cacache.index.compact(options.cachePath, cacheKey(request), (A, B) => {
        const entryA = new CacheEntry({ entry: A, options })
        const entryB = new CacheEntry({ entry: B, options })
        return entryA.policy.satisfies(entryB.request)
      })
    } catch (err) {
      // if the compact request fails, ignore the error and return
      return
    }

    // find the specific entry that satisfies the request
    let match
    for (const entry of matches) {
      const _entry = new CacheEntry({
        entry,
        options,
      })

      if (_entry.policy.satisfies(request)) {
        match = _entry
        break
      }
    }

    return match
  }

  get request () {
    if (!this[_request]) {
      this[_request] = new Request(this.entry.metadata.url, {
        method: 'GET',
        headers: this.entry.metadata.reqHeaders,
      })
    }

    return this[_request]
  }

  get response () {
    if (!this[_response]) {
      this[_response] = new Response(null, {
        counter: this.options.counter,
        status: this.entry.metadata.status || 200,
        headers: {
          ...this.entry.metadata.resHeaders,
          'content-length': this.entry.size,
        },
      })
    }

    return this[_response]
  }

  get policy () {
    if (!this[_policy]) {
      this[_policy] = new CachePolicy({
        entry: this.entry,
        request: this.request,
        response: this.response,
        options: this.options,
      })
    }

    return this[_policy]
  }

  // wraps the response in a pipeline that stores the data
  // in the cache while the user consumes it
  async store (status) {
    // if we got a status other than 200, 301, or 308,
    // or the CachePolicy forbid storage, append the
    // cache status header and return it untouched
    if (this.request.method !== 'GET' || ![200, 301, 308].includes(this.response.status) || !this.policy.storable()) {
      this.response.headers.set('x-local-cache-status', 'skip')
      return this.response
    }

    const size = Number(this.response.headers.get('content-length'))
    const fitsInMemory = !!size && size < MAX_MEM_SIZE
    const shouldBuffer = this.options.memoize !== false && fitsInMemory
    const cacheOpts = {
      algorithms: this.options.algorithms,
      metadata: {
        url: this.request.url,
        reqHeaders: {},
        resHeaders: {},
      },
      size,
      memoize: fitsInMemory && this.options.memoize,
    }

    // only save the status if it's not a 200
    if (this.response.status !== 200)
      cacheOpts.metadata.status = this.response.status

    for (const name of KEEP_REQUEST_HEADERS) {
      if (this.request.headers.has(name))
        cacheOpts.metadata.reqHeaders[name] = this.request.headers.get(name)
    }

    // if the request's host header differs from the host in the url
    // we need to keep it, otherwise it's just noise and we ignore it
    const host = this.request.headers.get('host')
    const parsedUrl = new url.URL(this.request.url)
    if (host && parsedUrl.host !== host)
      cacheOpts.metadata.reqHeaders.host = host

    // if the response has a vary header, make sure
    // we store the relevant request headers too
    if (this.response.headers.has('vary')) {
      const vary = this.response.headers.get('vary')
      // a vary of "*" means every header causes a different response.
      // in that scenario, we do not include any additional headers
      // as the freshness check will always fail anyway and we don't
      // want to bloat the cache indexes
      if (vary !== '*') {
        // copy any other request headers that will vary the response
        const varyHeaders = vary.trim().toLowerCase().split(/\s*,\s*/)
        for (const name of varyHeaders) {
          // explicitly ignore accept-encoding here
          if (name !== 'accept-encoding' && this.request.headers.has(name))
            cacheOpts.metadata.reqHeaders[name] = this.request.headers.get(name)
        }
      }
    }

    for (const name of KEEP_RESPONSE_HEADERS) {
      if (this.response.headers.has(name))
        cacheOpts.metadata.resHeaders[name] = this.response.headers.get(name)
    }

    // we only store accept-encoding and content-encoding if the user
    // has disabled automatic compression and decompression in minipass-fetch
    // since if it's enabled (the default) then the content will have
    // already been decompressed making the header a lie
    if (this.options.compress === false) {
      cacheOpts.metadata.reqHeaders['accept-encoding'] = this.request.headers.get('accept-encoding')
      cacheOpts.metadata.resHeaders['content-encoding'] = this.response.headers.get('content-encoding')
    }

    let body = null
    // we only set a body if the status is a 200, redirects are
    // stored as metadata only
    if (this.response.status === 200) {
      let cacheWriteResolve, cacheWriteReject
      const cacheWritePromise = new Promise((resolve, reject) => {
        // we save the info from the write here so we can use the time and
        // hash as part of the response headers
        cacheWriteResolve = resolve
        cacheWriteReject = reject
      })

      body = new MinipassPipeline(new MinipassFlush({
        flush () {
          return cacheWritePromise
        },
      }))

      let abortStream
      if (shouldBuffer) {
        // if the result fits in memory, use a collect stream to gather
        // the response and write it to cacache while also passing it through
        // to the user
        const collector = new MinipassCollect.PassThrough()
        abortStream = collector
        collector.on('collect', (data) => {
          // TODO if the cache write fails, log a warning but return the response anyway
          cacache.put(this.options.cachePath, this.key, data, cacheOpts).then(cacheWriteResolve, cacheWriteReject)
        })
        body.unshift(collector)
      } else {
        // if it does not fit in memory, create a tee stream and use
        // that to pipe to both the cache and the user simultaneously
        const tee = new Minipass()
        const cacheStream = cacache.put.stream(this.options.cachePath, this.key, cacheOpts)
        abortStream = cacheStream
        tee.pipe(cacheStream)
        // TODO if the cache write fails, log a warning but return the response anyway
        cacheStream.promise().then(cacheWriteResolve, cacheWriteReject)
        body.unshift(tee)
      }

      this.response.body.on('error', (err) => {
        // the abortStream will either be a MinipassCollect if we buffer
        // or a cacache write stream, either way be sure to listen for
        // errors from the actual response and avoid writing data that we
        // know to be invalid to the cache
        abortStream.destroy(err)
      })

      body.unshift(this.response.body)
    } else
      await cacache.index.insert(this.options.cachePath, this.key, null, cacheOpts)

    // note: we do not set the x-local-cache-hash header because we do not know
    // the hash value until after the write to the cache completes, which doesn't
    // happen until after the response has been sent and it's too late to write
    // the header anyway
    this.response.headers.set('x-local-cache', encodeURIComponent(this.options.cachePath))
    this.response.headers.set('x-local-cache-key', encodeURIComponent(this.key))
    this.response.headers.set('x-local-cache-mode', shouldBuffer ? 'buffer' : 'stream')
    this.response.headers.set('x-local-cache-status', status)
    this.response.headers.set('x-local-cache-time', new Date().toISOString())
    const newResponse = new Response(body, {
      status: this.response.status,
      headers: this.response.headers,
      counter: this.options.counter,
    })
    return newResponse
  }

  // use the cached data to create a response and return it
  async respond (method, options, status) {
    let response
    const size = Number(this.response.headers.get('content-length'))
    const fitsInMemory = !!size && size < MAX_MEM_SIZE
    const shouldBuffer = this.options.memoize !== false && fitsInMemory
    if (method === 'HEAD' || [301, 308].includes(this.response.status)) {
      // if the request is a HEAD, or the response is a redirect,
      // then the metadata in the entry already includes everything
      // we need to build a response
      response = this.response
    } else {
      // we're responding with a full cached response, so create a body
      // that reads from cacache and attach it to a new Response
      const body = new Minipass()
      const removeOnResume = () => body.removeListener('resume', onResume)
      let onResume
      if (shouldBuffer) {
        onResume = async () => {
          removeOnResume()
          try {
            const content = await cacache.get.byDigest(this.options.cachePath, this.entry.integrity, { memoize: this.options.memoize })
            body.end(content)
          } catch (err) {
            body.emit('error', err)
          }
        }
      } else {
        onResume = () => {
          const cacheStream = cacache.get.stream.byDigest(this.options.cachePath, this.entry.integrity, { memoize: this.options.memoize })
          cacheStream.on('error', (err) => body.emit('error', err))
          cacheStream.pipe(body)
        }
      }

      body.once('resume', onResume)
      body.once('end', removeOnResume)
      response = new Response(body, {
        counter: options.counter,
        status: 200,
        headers: {
          ...this.policy.responseHeaders(),
        },
      })
    }

    response.headers.set('x-local-cache', encodeURIComponent(this.options.cachePath))
    response.headers.set('x-local-cache-hash', encodeURIComponent(this.entry.integrity))
    response.headers.set('x-local-cache-key', encodeURIComponent(this.key))
    response.headers.set('x-local-cache-mode', shouldBuffer ? 'buffer' : 'stream')
    response.headers.set('x-local-cache-status', status)
    response.headers.set('x-local-cache-time', new Date(this.entry.time).toUTCString())
    return response
  }

  // use the provided request along with this cache entry to
  // revalidate the stored response. returns a response, either
  // from the cache or from the update
  async revalidate (request, options) {
    const revalidateRequest = new Request(request, {
      headers: this.policy.revalidationHeaders(request),
    })

    try {
      // NOTE: be sure to remove the headers property from the
      // user supplied options, since we have already defined
      // them on the new request object. if they're still in the
      // options then those will overwrite the ones from the policy
      var response = await remote(revalidateRequest, {
        ...options,
        headers: undefined,
      })
    } catch (err) {
      // if the network fetch fails, return the stale
      // cached response unless it has a cache-control
      // of 'must-revalidate'
      if (!this.policy.mustRevalidate)
        return this.respond(request.method, options, 'stale')

      throw err
    }

    if (this.policy.revalidated(revalidateRequest, response)) {
      // we got a 304, write a new index to the cache with the
      // revalidate response's date header and respond from cache
      this.entry.metadata.resHeaders.date = response.headers.get('date')
      try {
        await cacache.index.insert(options.cachePath, this.key, this.entry.integrity, {
          size: this.entry.size,
          metadata: this.entry.metadata,
        })
      } catch (err) {
        // if updating the cache index fails, we ignore it and
        // respond anyway
      }
      return this.respond(request.method, options, 'revalidated')
    }

    // if we got a modified response, create a new entry based on it
    const newEntry = new CacheEntry({
      // keep the original request since we don't want any
      // revalidation related header changes in the index
      request: this.request,
      response,
      options,
      fetch: this.fetch,
    })

    // respond with the new entry while writing it to the cache
    return newEntry.store('updated')
  }
}

module.exports = CacheEntry