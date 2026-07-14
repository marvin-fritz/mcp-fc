export interface LoginPageParams {
  clientName: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  error?: string;
  email?: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const hidden = (name: string, value: string | undefined): string =>
  value ? `<input type="hidden" name="${esc(name)}" value="${esc(value)}">` : '';

/** Self-contained dark login page (no external assets). Posts to /oauth/login. */
export function renderLoginPage(p: LoginPageParams): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Finanz-Copilot MCP — Anmelden</title>
<style>
body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;width:340px}
h1{font-size:18px;margin:0 0 4px}p{color:#8b949e;font-size:13px;margin:0 0 20px}
label{display:block;font-size:13px;margin:12px 0 4px}
input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;font-size:14px}
button{width:100%;margin-top:20px;padding:10px;border:0;border-radius:8px;background:#2f81f7;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
.err{background:#3d1d20;border:1px solid #f85149;color:#ffa198;border-radius:8px;padding:10px;font-size:13px;margin-bottom:8px}
.scopes{color:#8b949e;font-size:12px;margin-top:16px}
</style></head><body>
<div class="card">
<h1>Finanz-Copilot MCP</h1>
<p><strong>${esc(p.clientName)}</strong> möchte auf deine Finanzdaten zugreifen. Melde dich mit deinem Finanz-Copilot-Konto an.</p>
${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}
<form method="post" action="/oauth/login">
${hidden('client_id', p.clientId)}
${hidden('redirect_uri', p.redirectUri)}
${hidden('code_challenge', p.codeChallenge)}
${hidden('state', p.state)}
${hidden('scope', p.scopes.join(' '))}
${hidden('resource', p.resource)}
<label for="email">E-Mail</label>
<input id="email" type="email" name="email" required autocomplete="username" value="${esc(p.email ?? '')}">
<label for="password">Passwort</label>
<input id="password" type="password" name="password" required autocomplete="current-password">
<button type="submit">Anmelden</button>
</form>
<div class="scopes">Zugriff: ${esc(p.scopes.length ? p.scopes.join(', ') : 'gemäß Kontorolle')} · nur lesend, sofern nicht anders angegeben</div>
</div></body></html>`;
}
