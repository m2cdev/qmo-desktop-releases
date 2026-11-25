// Desktop extension check (test harness, not shipped). Loads the REAL built Qmo Desktop coach panel
// (out/preload + out/renderer/coach.html, its real CSP, file: origin) in the app's own Electron and
// mounts a Qmo-approved partner extension at pre_call and post_call in the live extension host frame
// (https://qmo-ext-host.vercel.app). The panel's API calls are answered by:
//   MODE=record: live https://app.heyqmo.com with a test rep's token (TOKEN_FILE); every answer is saved to FIXTURE
//   MODE=replay: the answers saved in FIXTURE (no token, no secret; CI on macOS and Windows)
// Only GET /api/desktop/dialer-calls is stubbed (one logged call for the lead) so post_call opens without a phone call.
// env: OUT (desktop out dir), MODE, FIXTURE, TOKEN_FILE (record only), RESULT (json path), SHOTS (dir)
// Exit code 0 only when every check passes.
const { app, BrowserWindow, ipcMain } = require("electron")
const fs = require("fs"), path = require("path")
const OUT = process.env.OUT, MODE = process.env.MODE || "replay", FIXTURE = process.env.FIXTURE, APP = "https://app.heyqmo.com"
const fixture = MODE === "replay" ? JSON.parse(fs.readFileSync(FIXTURE, "utf8")) : { meta: { lead: process.env.LEAD, call: process.env.CALL, recordedAt: new Date().toISOString() }, answers: [] }
const LEAD = fixture.meta.lead, CALL = fixture.meta.call
const TOKEN = MODE === "record" ? fs.readFileSync(process.env.TOKEN_FILE, "utf8").trim() : null
const SHOTS = process.env.SHOTS || "."
fs.mkdirSync(SHOTS, { recursive: true })
const res = { mode: MODE, platform: process.platform, arch: process.arch, electron: process.versions.electron, steps: [], checks: [], api: [], links: [] }
const log = (s, d) => { res.steps.push({ at: new Date().toISOString(), s, ...(d ? { d } : {}) }); console.log(s, d ? JSON.stringify(d).slice(0, 300) : "") }
const check = (name, ok, d) => { res.checks.push({ name, ok: !!ok, d }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`, d ? JSON.stringify(d).slice(0, 200) : "") }
const keyOf = (method, p, body) => `${method} ${p} ${body === undefined ? "" : JSON.stringify(body)}`
const used = new Map()
async function api(method, p, body) {
  if (method === "GET" && p.startsWith("/api/desktop/dialer-calls")) return { ok: true, status: 200, body: { data: [{ id: CALL, startedAt: new Date().toISOString(), durationSec: 42, disposition: null, lead: { id: LEAD, name: "Dana Desk Test", company: null, phone: null } }] } }
  const k = keyOf(method, p, body)
  if (MODE === "replay") {
    const all = fixture.answers.filter((a) => a.key === k)
    const i = used.get(k) || 0; used.set(k, i + 1)
    const a = all[Math.min(i, all.length - 1)]
    res.api.push(`${k.slice(0, 200)} -> ${a ? a.status : "NOT RECORDED"}`)
    return a ? { ok: a.status < 400, status: a.status, body: a.body } : { ok: false, status: 599, body: { error: { message: "not in fixture" } } }
  }
  const r = await fetch(APP + p, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
  const json = await r.json().catch(() => null)
  fixture.answers.push({ key: k, status: r.status, body: json })
  res.api.push(`${k.slice(0, 200)} -> ${r.status}`)
  return { ok: r.ok, status: r.status, body: json }
}
const h = (ch, fn) => ipcMain.handle(ch, fn)
h("qmo:api", (_e, m, p, b) => api(m, p, b))
h("qmo:config", () => ({ appUrl: APP, realtimeUrl: "wss://invalid.test", platform: process.platform }))
h("qmo:openLink", (_e, u) => { res.links.push(u); return true })
h("coach:getLead", () => LEAD); h("coach:getMode", () => "cold_call"); h("coach:getHidden", () => false)
h("dialer:getState", () => ({ active: true, phase: "in_call", calls: 1, manualOnly: false })); h("dialer:shortcut", () => "")
for (const ch of ["qmo:user", "qmo:token", "workspace:get", "app:version", "update:state", "bubble:getShown", "detect:get"]) h(ch, () => null)
ipcMain.on("coach:resize", () => {}); ipcMain.on("coach:painted", () => {}); ipcMain.on("coach:event", () => {})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function extFrame(win, want) {
  for (let i = 0; i < 60; i++) {
    const f = win.webContents.mainFrame.framesInSubtree.find((x) => x.url.startsWith("https://qmo-ext-host.vercel.app/"))
    if (f) { try { const t = await f.executeJavaScript("document.body ? document.body.innerText : ''"); if (!want || t.includes(want)) return { f, t } } catch {} }
    await wait(500)
  }
  return { f: null, t: null }
}
const shot = async (win, name) => fs.writeFileSync(path.join(SHOTS, `${process.platform}-${name}.png`), (await win.webContents.capturePage()).toPNG())
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 420, height: 900, show: true, webPreferences: { preload: path.join(OUT, "preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  win.webContents.on("console-message", (_e, level, message) => { if (level >= 2) res.steps.push({ console: message.slice(0, 300) }) })
  try {
    await win.loadURL(require("url").pathToFileURL(path.join(OUT, "renderer/coach.html")).href)
    log("coach panel loaded", { url: win.webContents.getURL() })
    const pre = await extFrame(win, "City:")
    const slot = await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('[data-ext-point]'); const fr = s && s.querySelector('iframe'); return s ? { point: s.dataset.extPoint, sandbox: fr && fr.getAttribute('sandbox'), src: fr && fr.src } : null })()`)
    log("pre_call slot", { slot, frameText: pre.t })
    await shot(win, "pre_call")
    check("pre_call: the partner extension renders in the live extension host with the lead's city", slot && slot.point === "pre_call" && pre.t && pre.t.includes("City: Dallas") && pre.t.includes("Lead: Dana"), { slot, text: pre.t })
    check("pre_call: the frame is sandboxed (allow-scripts only, no same origin)", slot && slot.sandbox === "allow-scripts", slot && slot.sandbox)
    if (pre.f) {
      const probe = await pre.f.executeJavaScript(`(async () => { const o = {}; try { o.parentDom = !!window.parent.document } catch (e) { o.parentDom = 'blocked' }
        try { o.cookie = document.cookie } catch (e) { o.cookie = 'blocked' } try { localStorage.length; o.storage = 'open' } catch (e) { o.storage = 'blocked' }
        try { const r = await fetch('${APP}/api/auth/me', { credentials: 'include' }); o.fetchQmo = r.status } catch (e) { o.fetchQmo = 'blocked' }
        try { o.qmoBridge = typeof window.qmo } catch (e) { o.qmoBridge = 'error' } o.origin = String(self.origin); return o })()`)
      log("frame isolation probe", probe)
      check("isolation: the partner code can't reach the app's page, cookies, storage or Qmo's API", probe.parentDom === "blocked" && probe.cookie === "blocked" && probe.storage === "blocked" && probe.fetchQmo === "blocked" && probe.qmoBridge === "undefined" && probe.origin === "null", probe)
      await pre.f.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('Set city to Austin')); if (b) b.click(); return !!b })()`)
      const after = await extFrame(win, "City: Austin")
      log("pre_call write re-rendered", { ok: !!after.f, text: after.t }); await wait(1000); await shot(win, "pre_call-after-write")
      check("pre_call: the partner button saves the city through the bridge and the panel re-renders", !!after.f && res.api.some((x) => x.includes('"method":"updateField"') && / -> 200$/.test(x)), { text: after.t })
    }
    win.webContents.send("coach:event", { type: "call_ended", callSessionId: CALL, durationSec: 42 })
    let postSlot = null
    for (let i = 0; i < 40 && !postSlot; i++) { await wait(500); postSlot = await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('[data-ext-point="post_call"]'); return s ? { status: s.querySelector('[data-ext-status]')?.dataset.extStatus } : null })()`) }
    const post = await extFrame(win, "City: Austin")
    await wait(1500)
    postSlot = await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('[data-ext-point="post_call"]'); return s ? { status: s.querySelector('[data-ext-status]')?.dataset.extStatus, preStillMounted: !!document.querySelector('[data-ext-point="pre_call"]') } : null })()`)
    log("post_call slot", { postSlot, frameText: post.t })
    await shot(win, "post_call")
    check("post_call: after the call ends the extension renders on the post-call screen with the saved city", postSlot && postSlot.status === "ready" && !postSlot.preStillMounted && post.t && post.t.includes("City: Austin"), { postSlot, text: post.t })
    if (MODE === "replay") check("every server answer came from the recorded live run", !res.api.some((x) => x.endsWith("NOT RECORDED")), res.api.filter((x) => x.endsWith("NOT RECORDED")))
  } catch (e) { log("harness error", { e: String(e && e.stack || e) }); check("harness ran without an error", false, String(e)) }
  if (MODE === "record") fs.writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2))
  res.passed = res.checks.length > 0 && res.checks.every((c) => c.ok)
  fs.writeFileSync(process.env.RESULT, JSON.stringify(res, null, 2))
  console.log(res.passed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED")
  app.exit(res.passed ? 0 : 1)
})
