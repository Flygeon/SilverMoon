import { BrowserWindow, session, type WebContents } from "electron";
import { constants, createPublicKey, publicEncrypt, randomUUID } from "node:crypto";

interface CaptchaChallenge {
  gt: string;
  challenge: string;
}

interface CaptchaResult {
  challenge: string;
  validate: string;
  seccode: string;
}

const CANCELLED = "[BILI_CAPTCHA_CANCELLED] 已取消人机验证";
const pending = new Map<number, { requestId: string; cancel: () => void }>();
const CALLBACK = "https://silvermoon.invalid/bili-captcha";
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

function validField(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/** RSA/PKCS#1 v1.5 matches PiliPlus encrypt.RSA's default encoding. */
export function encryptBiliLogin(key: unknown, values: unknown): string[] {
  try {
    if (
      !validField(key, 8192) ||
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 4 ||
      !values.every((value) => validField(value, 512))
    ) {
      throw new Error();
    }
    const publicKey = createPublicKey(key);
    const bits = publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (publicKey.asymmetricKeyType !== "rsa" || bits < 1024 || bits > 4096) {
      throw new Error();
    }
    return values.map((value: string) => {
      const plain = Buffer.from(value, "utf8");
      try {
        if (plain.length > Math.ceil(bits / 8) - 11) throw new Error();
        return publicEncrypt(
          { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
          plain,
        ).toString("base64");
      } finally {
        plain.fill(0);
      }
    });
  } catch {
    // Native crypto errors can include details of inputs; never return them through IPC/logs.
    throw new Error("登录加密失败，请重新获取密钥或检查输入长度");
  }
}

/** Host-authored page; untrusted challenge values are serialized, never interpolated as code. */
export function buildBiliCaptchaHtml(challenge: CaptchaChallenge, nonce: string): string {
  const config = JSON.stringify({ ...challenge, nonce, callback: CALLBACK }).replace(
    /</g,
    "\\u003c",
  );
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src https: data: blob:; script-src https: 'unsafe-inline' 'unsafe-eval'; style-src https: 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>哔哩哔哩人机验证</title>
<style>body{margin:0;font:16px system-ui,sans-serif}#status{padding:24px;text-align:center}</style>
</head><body><p id="status">正在加载官方人机验证…</p><script>
const config=${config};
let C,S,t,sent=false;
const R=(state,result)=>{
  if(sent)return;sent=true;
  const url=new URL(config.callback);
  url.searchParams.set('nonce',config.nonce);
  url.searchParams.set('state',state);
  if(state==='success')url.searchParams.set('result',JSON.stringify(result));
  location.href=url.href;
};
const E=()=>R('error');
const T=()=>{if(C&&S&&!t){try{
  t=Geetest(C).onSuccess(()=>R('success',t.getValidate())).onError(E).onClose(()=>R('close'));
  t.onReady(()=>{document.getElementById('status').textContent='请完成下方验证';t.verify()});
}catch{E()}}};
window.geetest_config=d=>{
  if(!d||d.status!=='success'){E();return}
  C=Object.assign({gt:config.gt,challenge:config.challenge,offline:false,new_captcha:true,product:'bind',width:'100%',https:true,protocol:'https://'},d.data);T();
};
window.G=()=>{S=true;T()};window.E=E;
</script>
<script src="https://static.geetest.com/static/js/fullpage.0.0.0.js" onload="G()" onerror="E()"></script>
<script src="https://api.geetest.com/gettype.php?gt=${encodeURIComponent(challenge.gt)}&amp;callback=geetest_config" onerror="E()"></script>
</body></html>`;
}

/** Decode only the nonce-bound callback. Its URL is always blocked before any network access. */
export function parseBiliCaptchaResult(url: string, nonce: string): CaptchaResult {
  let callback: URL;
  try {
    callback = new URL(url);
  } catch {
    throw new Error("人机验证响应无效，请重新验证");
  }
  if (
    callback.origin + callback.pathname !== CALLBACK ||
    callback.searchParams.get("nonce") !== nonce
  ) {
    throw new Error("人机验证响应无效，请重新验证");
  }
  if (callback.searchParams.get("state") === "close") throw new Error(CANCELLED);
  if (callback.searchParams.get("state") !== "success") {
    throw new Error("官方人机验证加载失败，请检查网络后重试");
  }
  try {
    const raw = callback.searchParams.get("result");
    if (!raw || raw.length > 4096) throw new Error();
    const result = JSON.parse(raw) as Record<string, unknown>;
    if (
      !validField(result.geetest_challenge) ||
      !validField(result.geetest_validate) ||
      !validField(result.geetest_seccode)
    ) {
      throw new Error();
    }
    return {
      challenge: result.geetest_challenge,
      validate: result.geetest_validate,
      seccode: result.geetest_seccode,
    };
  } catch {
    throw new Error("人机验证响应不完整，请重新验证");
  }
}

export function cancelBiliCaptcha(sender: WebContents, requestId: unknown): void {
  const current = pending.get(sender.id);
  if (current && current.requestId === requestId) current.cancel();
}

export function solveBiliCaptcha(
  sender: WebContents,
  requestId: unknown,
  raw: unknown,
): Promise<CaptchaResult> {
  const challenge = raw as CaptchaChallenge | null;
  if (
    !validField(requestId, 128) ||
    !challenge ||
    !validField(challenge.gt, 128) ||
    !validField(challenge.challenge)
  ) {
    return Promise.reject(new Error("人机验证参数无效，请重新获取验证码"));
  }
  const parent = BrowserWindow.fromWebContents(sender);
  if (!parent || parent.isDestroyed() || sender.isDestroyed()) {
    return Promise.reject(new Error(CANCELLED));
  }
  pending.get(sender.id)?.cancel();
  const nonce = randomUUID();
  const isolatedSession = session.fromPartition(`bili-captcha-${nonce}`, { cache: false });
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, done) => done(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.on("will-download", (event) => event.preventDefault());
  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 420,
    height: 560,
    show: false,
    title: "哔哩哔哩人机验证",
    autoHideMenuBar: true,
    webPreferences: {
      session: isolatedSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
    },
  });
  win.setMenu(null);
  win.webContents.setUserAgent(MOBILE_UA);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result?: CaptchaResult, error = CANCELLED): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(sender.id);
      parent.removeListener("closed", cancel);
      sender.removeListener("destroyed", cancel);
      if (!win.isDestroyed()) win.destroy();
      void isolatedSession.clearStorageData().catch(() => {});
      if (result) resolve(result);
      else reject(new Error(error));
    };
    const cancel = (): void => finish();
    const timer = setTimeout(() => finish(undefined, "人机验证已超时，请重新验证"), 3 * 60 * 1000);
    pending.set(sender.id, { requestId, cancel });
    parent.once("closed", cancel);
    sender.once("destroyed", cancel);
    win.once("closed", cancel);
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) win.show();
    });
    win.webContents.on("will-frame-navigate", (event) => {
      // 官方验证可能使用子框架；隔离窗口不提供 preload 或宿主能力。
      if (!event.isMainFrame) return;
      event.preventDefault();
      try {
        finish(parseBiliCaptchaResult(event.url, nonce));
      } catch (error) {
        finish(undefined, (error as Error).message);
      }
    });
    win.webContents.on("will-redirect", (event) => event.preventDefault());
    win.webContents.once("render-process-gone", () =>
      finish(undefined, "人机验证窗口已退出，请重新验证"),
    );
    void win
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(buildBiliCaptchaHtml(challenge, nonce))}`,
      )
      .catch(() => finish(undefined, "人机验证页面加载失败，请重试"));
  });
}
