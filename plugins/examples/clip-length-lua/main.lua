-- An example ClipWorld plugin in Lua: asks for a length and gives every selected clip that length.
package.path = (os.getenv("CLIPWORLD_PLUGIN_DIR") or ".") .. "/?.lua;" .. package.path
local cw = require("clipworld")

cw.command("setLength", function(req)
  local ids = req.selection or {}
  if #ids == 0 then
    cw.api.showMessage("Select some clips first", "error")
    return
  end
  local answer = cw.api.askUser({
    title = "Make clips the same length",
    fields = cw.json.array({
      { key = "seconds", label = "Length (seconds)", type = "number", default = 2, min = 0.1, max = 600, step = 0.1 },
    }),
  })
  if not answer then return end -- cancelled
  for _, id in ipairs(ids) do
    cw.api.updateClip(id, { duration = tonumber(answer.seconds) })
  end
  return { message = string.format("Changed %d clips", #ids) }
end)

cw.start()
