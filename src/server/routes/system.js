const { execFile } = require("child_process");
const { readJson, json } = require("../lib/http");

async function mediaKey(req, res) {
  const { action } = await readJson(req);
  const keys = { next: 0xb0, previous: 0xb1, playpause: 0xb3, pause: 0xb3 };
  const key = keys[action];
  if (!key) return json(res, { ok: false, error: "Unknown media action." }, 400);
  if (process.platform !== "win32") return json(res, { ok: false, error: "Media key bridge is Windows-only right now." }, 501);

  const command = [
    "$sig='[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);';",
    "$type=Add-Type -MemberDefinition $sig -Name Win32Keyboard -Namespace Blue -PassThru;",
    `$type::keybd_event(${key},0,0,[UIntPtr]::Zero);`,
    `$type::keybd_event(${key},0,2,[UIntPtr]::Zero);`,
  ].join(" ");

  execFile("powershell", ["-NoProfile", "-Command", command], { windowsHide: true }, (error) => {
    json(res, { ok: !error, error: error?.message });
  });
}

module.exports = { mediaKey };
