-- ClipWorld plugin SDK for Lua 5.3 or newer. Copy this file next to your plugin's main file.
--
-- SPDX-License-Identifier: MIT
-- This SDK is MIT licensed (unlike ClipWorld itself, which is GPL-3.0-or-later), so plugins that use it
-- can be under any license. Copyright (C) 2026 Lorekeeper49.
--
--   package.path = (os.getenv("CLIPWORLD_PLUGIN_DIR") or ".") .. "/?.lua;" .. package.path
--   local cw = require("clipworld")
--   cw.command("hello", function(req) cw.api.showMessage("Hello!") end)
--   cw.start()
--
-- Each request runs in its own coroutine, so handlers can call cw.api.* (which waits for ClipWorld's
-- answer) as if it were an ordinary function. Use cw.log() instead of print(). See PLUGINS.md.

local M = {}

---------------------------------------------------------------- JSON

local json = {}
M.json = json
-- JSON null and empty arrays: Lua can't tell nil from missing, or {} from an empty array.
json.null = setmetatable({}, { __tostring = function() return "null" end })
json.array_mt = {}
function json.array(t) return setmetatable(t or {}, json.array_mt) end

local escapes = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }

local function is_array(t)
  if getmetatable(t) == json.array_mt then return true end
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" or k <= 0 or k % 1 ~= 0 then return false end
    n = n + 1
  end
  return n > 0 and n == #t
end

function json.encode(v)
  local t = type(v)
  if v == nil or v == json.null then return "null"
  elseif t == "boolean" then return v and "true" or "false"
  elseif t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    if math.type and math.type(v) == "integer" then return tostring(v) end
    return string.format("%.14g", v)
  elseif t == "string" then
    return '"' .. v:gsub('[%c"\\]', function(c) return escapes[c] or string.format("\\u%04x", c:byte()) end) .. '"'
  elseif t == "table" then
    local out = {}
    if is_array(v) then
      for i = 1, #v do out[i] = json.encode(v[i]) end
      return "[" .. table.concat(out, ",") .. "]"
    end
    for k, x in pairs(v) do out[#out + 1] = json.encode(tostring(k)) .. ":" .. json.encode(x) end
    return "{" .. table.concat(out, ",") .. "}"
  end
  error("can't encode a " .. t .. " as JSON")
end

local function utf8char(cp)
  if utf8 and utf8.char then return utf8.char(cp) end
  if cp < 0x80 then return string.char(cp) end
  if cp < 0x800 then return string.char(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F)) end
  if cp < 0x10000 then return string.char(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)) end
  return string.char(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
end

function json.decode(s)
  local i = 1
  local function ws() i = s:find("[^ \t\r\n]", i) or #s + 1 end
  local value
  local function str()
    local out = {}
    i = i + 1
    while true do
      local c = s:sub(i, i)
      if c == "" then error("unterminated string") end
      if c == '"' then i = i + 1; break end
      if c == "\\" then
        local e = s:sub(i + 1, i + 1)
        local map = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t", ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }
        if e == "u" then
          local cp = tonumber(s:sub(i + 2, i + 5), 16)
          i = i + 6
          if cp >= 0xD800 and cp <= 0xDBFF and s:sub(i, i + 1) == "\\u" then
            local lo = tonumber(s:sub(i + 2, i + 5), 16)
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00)
            i = i + 6
          end
          out[#out + 1] = utf8char(cp)
        else
          out[#out + 1] = map[e] or e
          i = i + 2
        end
      else
        local j = s:find('["\\]', i) or #s + 1
        out[#out + 1] = s:sub(i, j - 1)
        i = j
      end
    end
    return table.concat(out)
  end
  value = function()
    ws()
    local c = s:sub(i, i)
    if c == "{" then
      local obj = {}
      i = i + 1
      ws()
      if s:sub(i, i) == "}" then i = i + 1; return obj end
      while true do
        ws()
        local k = str()
        ws()
        i = i + 1 -- :
        obj[k] = value()
        ws()
        local d = s:sub(i, i)
        i = i + 1
        if d == "}" then return obj end
      end
    elseif c == "[" then
      local arr = json.array({})
      i = i + 1
      ws()
      if s:sub(i, i) == "]" then i = i + 1; return arr end
      while true do
        arr[#arr + 1] = value()
        ws()
        local d = s:sub(i, i)
        i = i + 1
        if d == "]" then return arr end
      end
    elseif c == '"' then return str()
    elseif s:sub(i, i + 3) == "true" then i = i + 4; return true
    elseif s:sub(i, i + 4) == "false" then i = i + 5; return false
    elseif s:sub(i, i + 3) == "null" then i = i + 4; return json.null
    else
      local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", i)
      if not num or num == "" then error("bad JSON at " .. i) end
      i = i + #num
      return math.tointeger and (math.tointeger(tonumber(num)) or tonumber(num)) or tonumber(num)
    end
  end
  return value()
end

---------------------------------------------------------------- messages

local next_id = 1
local waiting = {}      -- request id -> coroutine waiting for the answer
local handlers = { command = {}, import = {}, export = {}, effect = {}, panel = {} }
local on_shutdown = nil

local function send(msg)
  msg.jsonrpc = "2.0"
  io.stdout:write(json.encode(msg), "\n")
  io.stdout:flush()
end

--- Writes to the plugin's messages (stderr); print() would break the protocol.
function M.log(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
  io.stderr:write(table.concat(parts, " "), "\n")
end

--- Sends a request to ClipWorld and waits (inside a handler) for its answer.
function M.call(method, params)
  local co = coroutine.running()
  assert(co, "cw.call can only be used inside a handler")
  local id = next_id
  next_id = next_id + 1
  waiting[id] = co
  send({ id = id, method = method, params = params or {} })
  local ok, value = coroutine.yield()
  if not ok then error(value, 0) end
  if value == json.null then return nil end
  return value
end

function M.notify(method, params) send({ method = method, params = params or {} }) end

local call = M.call
--- Everything a plugin can ask ClipWorld (see PLUGINS.md for each one).
M.api = {
  getProject = function() return call("getProject") end,
  setProject = function(project) return call("setProject", { project = project }) end,
  getSelection = function() return call("getSelection") end,
  setSelection = function(ids) return call("setSelection", { ids = json.array(ids) }) end,
  getPlayhead = function() return call("getPlayhead") end,
  setPlayhead = function(time) return call("setPlayhead", { time = time }) end,
  importMedia = function(paths) return call("importMedia", { paths = json.array(paths) }) end,
  addMediaClip = function(mediaId, start, trackId) return call("addMediaClip", { mediaId = mediaId, start = start, trackId = trackId }) end,
  addTextClip = function(start, text, duration) return call("addTextClip", { start = start, text = text or {}, duration = duration }) end,
  updateClip = function(id, changes) return call("updateClip", { id = id, changes = changes }) end,
  removeClips = function(ids) return call("removeClips", { ids = json.array(ids) }) end,
  addEffect = function(clipId, type_, params) return call("addEffect", { clipId = clipId, type = type_, params = params or {} }) end,
  addSubtitleTrack = function(name, cues, language, addClip)
    return call("addSubtitleTrack", { name = name, cues = json.array(cues), language = language or "eng", addClip = addClip ~= false })
  end,
  showMessage = function(text, kind) return call("showMessage", { text = text, kind = kind or "info" }) end,
  askUser = function(form) return call("askUser", form) end,
  pickFile = function(options) return call("pickFile", options or {}) end,
  getAppInfo = function() return call("getAppInfo") end,
  postToPanel = function(panel, data) M.notify("postToPanel", { panel = panel, data = data }) end,
}

--- Registers what the plugin does, by the ids given in plugin.json.
function M.command(id, fn) handlers.command[id] = fn end
function M.importer(id, fn) handlers.import[id] = fn end
function M.exporter(id, fn) handlers.export[id] = fn end
--- fn(params, info) returns the ffmpeg filter chain for the effect's settings.
function M.effect(id, fn) handlers.effect[id] = fn end
function M.panel(id, fn) handlers.panel[id] = fn end
function M.onShutdown(fn) on_shutdown = fn end

local function pick(kind, id)
  local fn = handlers[kind][id]
  if not fn then error("This plugin has no " .. kind .. ' "' .. tostring(id) .. '"', 0) end
  return fn
end

local function handle(method, p)
  if method == "initialize" then M.info = p; return { ok = true } end
  if method == "command" then return pick("command", p.command)(p) end
  if method == "import" then return pick("import", p.importer)(p) end
  if method == "export" then return pick("export", p.exporter)(p) end
  if method == "effectFilter" then
    local info = {}
    for k, v in pairs(p) do if k ~= "effect" and k ~= "params" then info[k] = v end end
    return { filter = pick("effect", p.effect)(p.params or {}, info) }
  end
  error('Unknown method "' .. tostring(method) .. '"', 0)
end

local function run(co, ...)
  local ok, err = coroutine.resume(co, ...)
  if not ok then M.log(err) end
end

--- Reads ClipWorld's messages until it closes the plugin.
function M.start()
  for line in io.stdin:lines() do
    if line:match("%S") then
      local ok, msg = pcall(json.decode, line)
      if ok and type(msg) == "table" then
        local method = msg.method
        local p = (msg.params ~= json.null and msg.params) or {}
        if method and (msg.id == nil or msg.id == json.null) then
          if method == "panelMessage" and handlers.panel[p.panel] then
            run(coroutine.create(handlers.panel[p.panel]), p.data)
          elseif method == "shutdown" then
            if on_shutdown then on_shutdown() end
            return
          end
        elseif method then
          local id = msg.id
          run(coroutine.create(function()
            local good, result = pcall(handle, method, p)
            if good then send({ id = id, result = result == nil and json.null or result })
            else send({ id = id, error = { code = -32000, message = tostring(result) } }) end
          end))
        elseif waiting[msg.id] then
          local co = waiting[msg.id]
          waiting[msg.id] = nil
          if msg.error and msg.error ~= json.null then run(co, false, msg.error.message or "Error")
          else run(co, true, msg.result) end
        end
      end
    end
  end
end

return M
