const axios = require('axios')
const logger = require('../utils/logger')
const ProxyHelper = require('../utils/proxyHelper')

const RESPONSES_MAIN_MODEL = 'gpt-5.4-mini'

function mimeTypeForFormat(outputFormat) {
  if (!outputFormat) return 'image/png'
  if (outputFormat.includes('/')) return outputFormat
  switch (outputFormat.toLowerCase().trim()) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    default:
      return 'image/png'
  }
}

function buildResponsesRequestBody(parsed) {
  const prompt = (parsed.prompt || '').trim()
  if (!prompt) {
    throw new Error('prompt is required')
  }

  const isEdit = parsed.endpoint === 'edits'

  const contentParts = [{ type: 'input_text', text: prompt }]

  if (parsed.images && parsed.images.length > 0) {
    for (const imageUrl of parsed.images) {
      contentParts.push({ type: 'input_image', image_url: imageUrl })
    }
  }

  if (isEdit && (!parsed.images || parsed.images.length === 0)) {
    throw new Error('image input is required for edits')
  }

  const action = isEdit ? 'edit' : 'generate'
  const toolModel = (parsed.model || 'gpt-image-2').trim()

  const tool = {
    type: 'image_generation',
    action,
    model: toolModel
  }

  if (parsed.n > 1 && toolModel.toLowerCase() !== 'dall-e-3') {
    tool.n = parsed.n
  }

  const optionalFields = ['size', 'quality', 'background', 'output_format', 'moderation', 'style']
  for (const field of optionalFields) {
    if (parsed[field]) {
      tool[field] = parsed[field].trim()
    }
  }

  if (parsed.output_compression !== undefined && parsed.output_compression !== null) {
    tool.output_compression = parsed.output_compression
  }
  if (parsed.partial_images !== undefined && parsed.partial_images !== null) {
    tool.partial_images = parsed.partial_images
  }

  if (parsed.mask) {
    tool.input_image_mask = { image_url: parsed.mask }
  }

  return {
    instructions: '',
    stream: true,
    reasoning: { effort: 'medium', summary: 'auto' },
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    model: RESPONSES_MAIN_MODEL,
    store: false,
    tool_choice: { type: 'image_generation' },
    input: [
      {
        type: 'message',
        role: 'user',
        content: contentParts
      }
    ],
    tools: [tool]
  }
}

function parseMultipartRequest(req) {
  const parsed = {
    endpoint: 'generations',
    model: 'gpt-image-2',
    prompt: '',
    n: 1,
    size: null,
    quality: null,
    background: null,
    output_format: null,
    response_format: null,
    moderation: null,
    style: null,
    output_compression: null,
    partial_images: null,
    stream: false,
    images: [],
    mask: null
  }

  if (req.path.includes('/edits')) {
    parsed.endpoint = 'edits'
  }

  if (req.body) {
    if (req.body.model) parsed.model = req.body.model
    if (req.body.prompt) parsed.prompt = req.body.prompt
    if (req.body.n) parsed.n = parseInt(req.body.n, 10) || 1
    if (req.body.size) parsed.size = req.body.size
    if (req.body.quality) parsed.quality = req.body.quality
    if (req.body.background) parsed.background = req.body.background
    if (req.body.output_format) parsed.output_format = req.body.output_format
    if (req.body.response_format) parsed.response_format = req.body.response_format
    if (req.body.moderation) parsed.moderation = req.body.moderation
    if (req.body.style) parsed.style = req.body.style
    if (req.body.output_compression !== undefined) {
      parsed.output_compression = parseInt(req.body.output_compression, 10)
    }
    if (req.body.partial_images !== undefined) {
      parsed.partial_images = parseInt(req.body.partial_images, 10)
    }
    if (req.body.stream === true || req.body.stream === 'true') {
      parsed.stream = true
    }
  }

  if (req.files) {
    const imageFiles = Array.isArray(req.files.image) ? req.files.image : req.files.image ? [req.files.image] : []
    for (const file of imageFiles) {
      const contentType = file.mimetype || 'image/png'
      const b64 = file.buffer.toString('base64')
      parsed.images.push(`data:${contentType};base64,${b64}`)
    }

    if (req.files.mask) {
      const maskFile = Array.isArray(req.files.mask) ? req.files.mask[0] : req.files.mask
      const contentType = maskFile.mimetype || 'image/png'
      const b64 = maskFile.buffer.toString('base64')
      parsed.mask = `data:${contentType};base64,${b64}`
    }
  }

  return parsed
}

function parseJsonRequest(req) {
  const body = req.body || {}
  const parsed = {
    endpoint: req.path.includes('/edits') ? 'edits' : 'generations',
    model: body.model || 'gpt-image-2',
    prompt: body.prompt || '',
    n: parseInt(body.n, 10) || 1,
    size: body.size || null,
    quality: body.quality || null,
    background: body.background || null,
    output_format: body.output_format || null,
    response_format: body.response_format || null,
    moderation: body.moderation || null,
    style: body.style || null,
    output_compression: body.output_compression !== undefined ? body.output_compression : null,
    partial_images: body.partial_images !== undefined ? body.partial_images : null,
    stream: body.stream === true,
    images: [],
    mask: null
  }

  if (body.image) {
    const images = Array.isArray(body.image) ? body.image : [body.image]
    parsed.images = images.map((img) => {
      if (typeof img === 'string') return img
      return null
    }).filter(Boolean)
  }

  if (body.mask) {
    parsed.mask = typeof body.mask === 'string' ? body.mask : null
  }

  return parsed
}

function parseImageRequest(req) {
  const contentType = (req.headers['content-type'] || '').toLowerCase()
  if (contentType.includes('multipart/form-data')) {
    return parseMultipartRequest(req)
  }
  return parseJsonRequest(req)
}

function extractImageResults(sseBody) {
  const results = []
  let createdAt = Math.floor(Date.now() / 1000)
  let usageData = null
  let meta = {}
  let upstreamError = null

  const lines = sseBody.split('\n')
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const jsonStr = line.slice(5).trim()
    if (!jsonStr || jsonStr === '[DONE]') continue

    let payload
    try {
      payload = JSON.parse(jsonStr)
    } catch {
      continue
    }

    const eventType = payload.type

    if (eventType === 'error' || eventType === 'response.failed') {
      const errorObj = eventType === 'error' ? payload.error : payload.response?.error
      if (errorObj) {
        upstreamError = {
          type: errorObj.type || 'upstream_error',
          code: errorObj.code || '',
          message: errorObj.message || 'Upstream request failed',
          param: errorObj.param || ''
        }
      }
      continue
    }

    if (
      eventType === 'response.created' ||
      eventType === 'response.in_progress' ||
      eventType === 'response.completed'
    ) {
      const response = payload.response
      if (response) {
        const tool = response.tools?.[0]
        if (tool) {
          if (tool.output_format) meta.output_format = tool.output_format
          if (tool.size) meta.size = tool.size
          if (tool.background) meta.background = tool.background
          if (tool.quality) meta.quality = tool.quality
          if (tool.model) meta.model = tool.model
        }
        if (response.created_at) createdAt = response.created_at

        if (response.tool_usage?.image_gen) {
          usageData = response.tool_usage.image_gen
        }
      }
    }

    if (eventType === 'response.output_item.done') {
      const item = payload.item
      if (item && item.type === 'image_generation_call' && item.result) {
        results.push({
          result: item.result,
          revised_prompt: item.revised_prompt || '',
          output_format: item.output_format || meta.output_format || '',
          size: item.size || meta.size || '',
          background: item.background || meta.background || '',
          quality: item.quality || meta.quality || ''
        })
      }
    }

    if (eventType === 'response.completed' && payload.response?.output) {
      const output = payload.response.output
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item.type !== 'image_generation_call' || !item.result) continue
          const exists = results.some((r) => r.result === item.result)
          if (!exists) {
            results.push({
              result: item.result,
              revised_prompt: item.revised_prompt || '',
              output_format: item.output_format || meta.output_format || '',
              size: item.size || meta.size || '',
              background: item.background || meta.background || '',
              quality: item.quality || meta.quality || ''
            })
          }
        }
      }
    }
  }

  return { results, createdAt, usageData, meta, upstreamError }
}

function buildApiResponse(imageResults, createdAt, usageData, meta, responseFormat) {
  const format = (responseFormat || 'b64_json').toLowerCase().trim()

  const data = imageResults.map((img) => {
    const item = {}
    if (format === 'url') {
      item.url = `data:${mimeTypeForFormat(img.output_format)};base64,${img.result}`
    } else {
      item.b64_json = img.result
    }
    if (img.revised_prompt) {
      item.revised_prompt = img.revised_prompt
    }
    return item
  })

  const response = { created: createdAt, data }

  if (meta.background) response.background = meta.background
  if (meta.output_format) response.output_format = meta.output_format
  if (meta.quality) response.quality = meta.quality
  if (meta.size) response.size = meta.size
  if (meta.model) response.model = meta.model
  if (usageData) response.usage = usageData

  return response
}

async function forwardViaOAuthBridge(parsed, accessToken, account, proxy) {
  const responsesBody = buildResponsesRequestBody(parsed)

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'OpenAI-Beta': 'responses=experimental',
    originator: 'opencode'
  }

  if (account.accountId || account.chatgptUserId) {
    headers['chatgpt-account-id'] = account.accountId || account.chatgptUserId
  }

  const codexEndpoint = 'https://chatgpt.com/backend-api/codex/responses'

  const axiosConfig = {
    method: 'POST',
    url: codexEndpoint,
    headers,
    data: responsesBody,
    timeout: 600000,
    responseType: 'stream',
    validateStatus: () => true
  }

  if (proxy) {
    const proxyAgent = ProxyHelper.createProxyAgent(proxy)
    if (proxyAgent) {
      axiosConfig.httpAgent = proxyAgent
      axiosConfig.httpsAgent = proxyAgent
      axiosConfig.proxy = false
    }
  }

  logger.info('📤 Forwarding image request via OAuth bridge (Codex Responses API)', {
    model: parsed.model,
    endpoint: parsed.endpoint,
    imageCount: parsed.images?.length || 0,
    stream: parsed.stream
  })

  return axios(axiosConfig)
}

async function forwardViaApiKey(parsed, apiKey, account, proxy) {
  const endpoint =
    parsed.endpoint === 'edits'
      ? '/v1/images/edits'
      : '/v1/images/generations'

  const baseApi = (account.baseApi || 'https://api.openai.com').replace(/\/+$/, '')
  const targetUrl = `${baseApi}${endpoint}`

  const requestBody = {
    model: parsed.model || 'gpt-image-2',
    prompt: parsed.prompt,
    n: parsed.n || 1
  }
  if (parsed.size) requestBody.size = parsed.size
  if (parsed.quality) requestBody.quality = parsed.quality
  if (parsed.response_format) requestBody.response_format = parsed.response_format
  if (parsed.background) requestBody.background = parsed.background
  if (parsed.style) requestBody.style = parsed.style
  if (parsed.output_format) requestBody.output_format = parsed.output_format

  if (parsed.images && parsed.images.length > 0) {
    requestBody.image = parsed.images[0]
  }
  if (parsed.mask) {
    requestBody.mask = parsed.mask
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  }

  const axiosConfig = {
    method: 'POST',
    url: targetUrl,
    headers,
    data: requestBody,
    timeout: 600000,
    validateStatus: () => true
  }

  if (proxy) {
    const proxyAgent = ProxyHelper.createProxyAgent(proxy)
    if (proxyAgent) {
      axiosConfig.httpAgent = proxyAgent
      axiosConfig.httpsAgent = proxyAgent
      axiosConfig.proxy = false
    }
  }

  logger.info('📤 Forwarding image request via API Key (OpenAI Images API)', {
    model: parsed.model,
    endpoint: parsed.endpoint,
    targetUrl
  })

  return axios(axiosConfig)
}

async function collectStreamBody(stream) {
  const chunks = []
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
    setTimeout(resolve, 300000)
  })
  return Buffer.concat(chunks).toString()
}

async function handleNonStreamImageResponse(res, upstreamResponse, parsed) {
  const body = await collectStreamBody(upstreamResponse.data)
  const { results, createdAt, usageData, meta, upstreamError } = extractImageResults(body)

  if (upstreamError) {
    const statusCode =
      upstreamError.code === 'moderation_blocked' ||
      upstreamError.type === 'image_generation_user_error'
        ? 400
        : 502
    return res.status(statusCode).json({ error: upstreamError })
  }

  if (results.length === 0) {
    return res.status(502).json({
      error: {
        message: 'Upstream did not return image output',
        type: 'upstream_error'
      }
    })
  }

  if (!meta.model) {
    meta.model = parsed.model || 'gpt-image-2'
  }

  const apiResponse = buildApiResponse(
    results,
    createdAt,
    usageData,
    meta,
    parsed.response_format
  )
  return res.status(200).json(apiResponse)
}

async function handleStreamImageResponse(res, upstreamResponse, parsed) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders()
  }

  const streamPrefix = parsed.endpoint === 'edits' ? 'image_edit' : 'image_generation'
  const format = (parsed.response_format || 'b64_json').toLowerCase().trim()
  const fallbackModel = parsed.model || 'gpt-image-2'

  let meta = { model: fallbackModel }
  let createdAt = Math.floor(Date.now() / 1000)
  let buffer = ''
  const pendingResults = []
  const emitted = new Set()

  const writeSSE = (eventName, payload) => {
    if (res.destroyed) return false
    try {
      if (eventName) {
        res.write(`event: ${eventName}\n`)
      }
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
      return true
    } catch {
      return false
    }
  }

  const processEvent = (jsonStr) => {
    let payload
    try {
      payload = JSON.parse(jsonStr)
    } catch {
      return
    }

    const eventType = payload.type

    if (
      eventType === 'response.created' ||
      eventType === 'response.in_progress' ||
      eventType === 'response.completed'
    ) {
      const response = payload.response
      if (response) {
        const tool = response.tools?.[0]
        if (tool) {
          if (tool.output_format) meta.output_format = tool.output_format
          if (tool.size) meta.size = tool.size
          if (tool.background) meta.background = tool.background
          if (tool.quality) meta.quality = tool.quality
          if (tool.model) meta.model = tool.model
        }
        if (response.created_at) createdAt = response.created_at
      }
    }

    if (eventType === 'response.image_generation_call.partial_image') {
      const b64 = (payload.partial_image_b64 || '').trim()
      if (!b64) return

      const eventName = `${streamPrefix}.partial_image`
      const partialPayload = {
        type: eventName,
        created_at: createdAt,
        partial_image_index: payload.partial_image_index || 0,
        b64_json: b64
      }
      if (format === 'url') {
        partialPayload.url = `data:${mimeTypeForFormat(meta.output_format)};base64,${b64}`
      }
      if (meta.background) partialPayload.background = meta.background
      if (meta.output_format) partialPayload.output_format = meta.output_format
      if (meta.quality) partialPayload.quality = meta.quality
      if (meta.size) partialPayload.size = meta.size
      if (meta.model) partialPayload.model = meta.model
      writeSSE(eventName, partialPayload)
    }

    if (eventType === 'response.output_item.done') {
      const item = payload.item
      if (item && item.type === 'image_generation_call' && item.result) {
        pendingResults.push({
          result: item.result,
          revised_prompt: item.revised_prompt || '',
          output_format: item.output_format || meta.output_format || '',
          size: item.size || meta.size || '',
          background: item.background || meta.background || '',
          quality: item.quality || meta.quality || ''
        })
      }
    }

    if (eventType === 'response.completed') {
      let usageRaw = null
      if (payload.response?.tool_usage?.image_gen) {
        usageRaw = payload.response.tool_usage.image_gen
      }

      let allResults = []
      if (payload.response?.output && Array.isArray(payload.response.output)) {
        for (const item of payload.response.output) {
          if (item.type !== 'image_generation_call' || !item.result) continue
          allResults.push({
            result: item.result,
            revised_prompt: item.revised_prompt || '',
            output_format: item.output_format || meta.output_format || '',
            size: item.size || meta.size || '',
            background: item.background || meta.background || '',
            quality: item.quality || meta.quality || ''
          })
        }
      }

      for (const pending of pendingResults) {
        const exists = allResults.some((r) => r.result === pending.result)
        if (!exists) allResults.push(pending)
      }

      const eventName = `${streamPrefix}.completed`
      for (const img of allResults) {
        const key = (img.output_format || '') + '|' + img.result
        if (emitted.has(key)) continue
        emitted.add(key)

        const completedPayload = {
          type: eventName,
          created_at: createdAt,
          b64_json: img.result
        }
        if (format === 'url') {
          completedPayload.url = `data:${mimeTypeForFormat(img.output_format)};base64,${img.result}`
        }
        if (img.background || meta.background) {
          completedPayload.background = img.background || meta.background
        }
        if (img.output_format || meta.output_format) {
          completedPayload.output_format = img.output_format || meta.output_format
        }
        if (img.quality || meta.quality) {
          completedPayload.quality = img.quality || meta.quality
        }
        if (img.size || meta.size) {
          completedPayload.size = img.size || meta.size
        }
        if (meta.model) completedPayload.model = meta.model
        if (usageRaw) completedPayload.usage = usageRaw
        writeSSE(eventName, completedPayload)
      }
    }

    if (eventType === 'error' || eventType === 'response.failed') {
      const errorObj =
        eventType === 'error' ? payload.error : payload.response?.error
      if (errorObj) {
        writeSSE('error', {
          type: 'error',
          error: {
            type: errorObj.type || 'upstream_error',
            message: errorObj.message || 'Upstream request failed',
            code: errorObj.code || ''
          }
        })
      }
    }
  }

  return new Promise((resolve) => {
    upstreamResponse.data.on('data', (chunk) => {
      buffer += chunk.toString()

      const parts = buffer.split('\n\n')
      buffer = parts.pop() || ''

      for (const part of parts) {
        if (!part.trim()) continue
        const lines = part.split('\n')
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim()
            if (jsonStr && jsonStr !== '[DONE]') {
              processEvent(jsonStr)
            }
          }
        }
      }
    })

    upstreamResponse.data.on('end', () => {
      if (buffer.trim()) {
        const lines = buffer.split('\n')
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim()
            if (jsonStr && jsonStr !== '[DONE]') {
              processEvent(jsonStr)
            }
          }
        }
      }

      if (emitted.size === 0 && pendingResults.length > 0) {
        const eventName = `${streamPrefix}.completed`
        for (const img of pendingResults) {
          const completedPayload = {
            type: eventName,
            created_at: createdAt,
            b64_json: img.result
          }
          if (format === 'url') {
            completedPayload.url = `data:${mimeTypeForFormat(img.output_format)};base64,${img.result}`
          }
          if (meta.model) completedPayload.model = meta.model
          writeSSE(eventName, completedPayload)
        }
      }

      if (!res.destroyed) res.end()
      resolve()
    })

    upstreamResponse.data.on('error', (err) => {
      logger.error('Image stream error:', err)
      if (!res.headersSent) {
        res.status(502).json({ error: { message: 'Upstream stream error' } })
      } else if (!res.destroyed) {
        writeSSE('error', {
          type: 'error',
          error: { type: 'upstream_error', message: 'Stream error' }
        })
        res.end()
      }
      resolve()
    })
  })
}

module.exports = {
  parseImageRequest,
  buildResponsesRequestBody,
  forwardViaOAuthBridge,
  forwardViaApiKey,
  handleNonStreamImageResponse,
  handleStreamImageResponse,
  extractImageResults,
  buildApiResponse
}
