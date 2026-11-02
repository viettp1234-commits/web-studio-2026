const crypto = require('crypto');
const fs = require('fs');
const querystring = require('querystring');

const TARGET_URL = 'https://lightvisual.studio';
const ADMIN_PASS = 'admin123';
const BRAND_NAME = 'AI Studio Pro';
const SECRET_KEY = 'khoa-bao-mat-proxy-2026';

const DB_FILE = '/tmp/database.json';
let db = {
    masterCookie: '_fbp=fb.1.1791519268646.363735489448337118; llmgw_session=M1Y2NgLnIDTr9nJ21I4RrvOGHLovdiW0pH8-obhseXE',
    masterCsrfToken: '',
    hideHistoryTabs: true,
    users: {
        'admin': { password: 'admin', durationMinutes: 5, firstLoginAt: null, maxQuota: 30, usedQuota: 0 }
    }
};

if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
}
const saveDB = () => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8'); } catch (e) {}
};

function signToken(data) {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

function verifyToken(token) {
    if (!token || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('base64url');
    if (sig !== expectedSig) return null;
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
}

function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name?.trim();
        if (name) list[name] = decodeURIComponent(rest.join('=').trim());
    });
    return list;
}

exports.handler = async (event) => {
    const reqPath = event.path || '/';
    const method = event.httpMethod || 'GET';
    const query = event.queryStringParameters || {};
    const cookies = parseCookies(event.headers.cookie || event.headers.Cookie);
    const bodyText = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');

    if (reqPath === '/sub-login' && method === 'GET') {
        const errorMsg = query.err || '';
        return {
            statusCode: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Đăng nhập - ${BRAND_NAME}</title><style>body{background:#0b0b0c;color:#fff;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.box{background:#161618;padding:32px;border-radius:14px;border:1px solid #2a2a2e;width:340px;box-shadow:0 10px 30px rgba(0,0,0,0.6)}h2{margin-top:0;text-align:center;color:#f59e0b}input{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #333;background:#0f0f10;color:#fff;box-sizing:border-box}button{width:100%;padding:12px;background:#ea580c;color:#fff;border:none;border-radius:8px;font-weight:bold;cursor:pointer;margin-top:10px}.err{color:#ef4444;font-size:13px;text-align:center;margin-bottom:10px}</style></head><body><div class="box"><h2>${BRAND_NAME}</h2>${errorMsg ? `<div class="err">${errorMsg}</div>` : ''}<form method="POST" action="/sub-login"><input type="text" name="username" placeholder="Tài khoản" required /><input type="password" name="password" placeholder="Mật khẩu" required /><button type="submit">Vào Studio</button></form></div></body></html>`
        };
    }

    if (reqPath === '/sub-login' && method === 'POST') {
        const form = querystring.parse(bodyText);
        const username = (form.username || '').trim();
        const password = (form.password || '').trim();
        const user = db.users[username];

        if (!user || user.password !== password) {
            return { statusCode: 302, headers: { Location: '/sub-login?err=' + encodeURIComponent('Sai tài khoản hoặc mật khẩu!') } };
        }

        const now = Date.now();
        if (!user.firstLoginAt) {
            user.firstLoginAt = now;
            saveDB();
        }
        const expireTime = user.firstLoginAt + user.durationMinutes * 60 * 1000;
        if (now > expireTime) {
            return { statusCode: 302, headers: { Location: '/sub-login?err=' + encodeURIComponent('Tài khoản đã hết thời gian sử dụng!') } };
        }

        const token = signToken({ username, expireTime, maxQuota: user.maxQuota, usedQuota: user.usedQuota || 0 });
        const maxAgeSec = Math.floor((expireTime - now) / 1000);
        return {
            statusCode: 302,
            headers: {
                'Set-Cookie': `sub_token=${token}; Path=/; HttpOnly; Max-Age=${maxAgeSec}`,
                'Location': '/'
            }
        };
    }

    if (reqPath === '/sub-logout') {
        return {
            statusCode: 302,
            headers: {
                'Set-Cookie': 'sub_token=; Path=/; HttpOnly; Max-Age=0',
                'Location': '/sub-login'
            }
        };
    }

    if (reqPath.startsWith('/my-admin')) {
        if (query.pass !== ADMIN_PASS) {
            return { statusCode: 403, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Sai mật khẩu Admin!' };
        }

        if (reqPath === '/my-admin/config' && method === 'POST') {
            const form = querystring.parse(bodyText);
            db.masterCookie = (form.masterCookie || '').trim();
            db.masterCsrfToken = (form.masterCsrfToken || '').trim();
            db.hideHistoryTabs = Boolean(form.hideHistoryTabs);
            saveDB();
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        if (reqPath === '/my-admin/user' && method === 'POST') {
            const form = querystring.parse(bodyText);
            db.users[(form.username || '').trim()] = {
                password: (form.password || '').trim(),
                durationMinutes: parseInt(form.durationMinutes, 10) || 60,
                firstLoginAt: null,
                maxQuota: parseInt(form.maxQuota, 10) || 30,
                usedQuota: 0
            };
            saveDB();
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        if (reqPath === '/my-admin/delete') {
            delete db.users[query.user];
            saveDB();
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        const userRows = Object.entries(db.users).map(([u, info]) => {
            let status = 'Chưa kích hoạt';
            if (info.firstLoginAt) {
                const remain = Math.round((info.firstLoginAt + info.durationMinutes * 60000 - Date.now()) / 60000);
                status = remain > 0 ? `Còn ${remain} phút` : 'Đã hết hạn';
            }
            return `<tr><td><b>${u}</b></td><td>${info.password}</td><td>${info.durationMinutes} phút</td><td>${status}</td><td>${info.usedQuota || 0} / ${info.maxQuota}</td><td><a href="/my-admin/delete?pass=${ADMIN_PASS}&user=${u}" style="color:#ef4444;">Xóa</a></td></tr>`;
        }).join('');

        return {
            statusCode: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Admin - ${BRAND_NAME}</title><style>body{background:#0f0f11;color:#e4e4e7;font-family:system-ui,sans-serif;padding:30px;max-width:900px;margin:auto}.card{background:#18181b;padding:20px;border-radius:10px;border:1px solid #27272a;margin-bottom:24px}input,textarea{width:100%;padding:10px;margin:6px 0 14px;background:#09090b;border:1px solid #3f3f46;color:#fff;border-radius:6px;box-sizing:border-box}button{background:#f59e0b;color:#000;border:none;padding:10px 20px;border-radius:6px;font-weight:bold;cursor:pointer}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #27272a;padding:10px;text-align:left}</style></head><body><h2>Quản trị Hệ thống Netlify (${BRAND_NAME})</h2><div class="card"><h3>1. Cấu hình Cookie gốc</h3><form method="POST" action="/my-admin/config?pass=${ADMIN_PASS}"><textarea name="masterCookie" rows="3">${db.masterCookie}</textarea><input type="text" name="masterCsrfToken" value="${db.masterCsrfToken}" placeholder="X-CSRF-Token (Nếu có)..." /><label><input type="checkbox" name="hideHistoryTabs" style="width:auto;" ${db.hideHistoryTabs ? 'checked' : ''} /> Ẩn tab Dự án & Thư viện</label><br><br><button type="submit">Lưu Cấu Hình Gốc</button></form></div><div class="card"><h3>2. Tạo / Gia hạn Tài khoản con</h3><form method="POST" action="/my-admin/user?pass=${ADMIN_PASS}"><input type="text" name="username" placeholder="Tên đăng nhập" required /><input type="text" name="password" placeholder="Mật khẩu" required /><input type="number" name="durationMinutes" placeholder="Số phút (VD: 120)" required /><input type="number" name="maxQuota" value="30" required /><button type="submit">Tạo / Cập nhật Tài khoản</button></form></div><div class="card"><h3>3. Danh sách Tài khoản</h3><table><tr><th>Tài khoản</th><th>Mật khẩu</th><th>Thời lượng</th><th>Trạng thái</th><th>Lượt bấm</th><th>Thao tác</th></tr>${userRows}</table></div></body></html>`
        };
    }

    const session = verifyToken(cookies.sub_token);
    if (!session || Date.now() > session.expireTime) {
        return { statusCode: 302, headers: { Location: '/sub-login' } };
    }

    const blockedPaths = ['/api', '/v1/balance', '/billing', '/payment', '/wallet'];
    if (blockedPaths.some(p => reqPath.toLowerCase() === p || reqPath.toLowerCase().startsWith('/v1/keys'))) {
        return { statusCode: 302, headers: { Location: '/' } };
    }

    const queryStr = event.rawQuery ? `?${event.rawQuery}` : '';
    const targetFullUrl = `${TARGET_URL}${reqPath}${queryStr}`;

    const fetchHeaders = {
        'Cookie': db.masterCookie,
        'Origin': TARGET_URL,
        'Referer': `${TARGET_URL}/`,
        'User-Agent': event.headers['user-agent'] || 'Mozilla/5.0'
    };
    if (db.masterCsrfToken) fetchHeaders['X-CSRF-Token'] = db.masterCsrfToken;
    if (event.headers['content-type']) fetchHeaders['Content-Type'] = event.headers['content-type'];

    try {
        const response = await fetch(targetFullUrl, {
            method,
            headers: fetchHeaders,
            body: ['GET', 'HEAD'].includes(method) ? undefined : (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body)
        });

        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('text/html')) {
            let html = await response.text();
            html = html.replace(/lightvisual\.studio/gi, BRAND_NAME).replace(/lightvisual/gi, BRAND_NAME);
            const remainSec = Math.max(0, Math.floor((session.expireTime - Date.now()) / 1000));
            const hideHistory = db.hideHistoryTabs ? 'true' : 'false';

            const shield = `<style>a[href*="/api"],a[href*="zalo.me"],a[href*="pricing"],a[href*="billing"]{display:none!important}#custom-timer-bar{position:fixed;bottom:14px;right:14px;z-index:999999;background:rgba(20,20,22,0.95);border:1px solid #f59e0b;color:#fff;padding:8px 14px;border-radius:8px;font-family:system-ui,sans-serif;font-size:13px}</style><div id="custom-timer-bar">⏳ Còn lại: <b id="time-left-val">--:--</b> | <a href="/sub-logout" style="color:#f59e0b;text-decoration:none;margin-left:6px;">Thoát</a></div><script>(function(){let sec=${remainSec};const t=document.getElementById('time-left-val');setInterval(()=>{sec--;if(sec<=0)location.href='/sub-logout';if(t)t.textContent=Math.floor(sec/60)+'p '+(sec%60<10?'0':'')+(sec%60)+'s'},1000);const f=['Tải App','Báo lỗi / Góp ý','Báo lỗi','Vào Nhóm Zalo','Gói Vô Hạn','Nạp','API','Lịch sử request','Tạo API key'];if(${hideHistory})f.push('Dự án','Thư viện');function c(){document.querySelectorAll('a,button,span,div,p,h1').forEach(el=>{if(el.children.length===0&&el.textContent){const txt=el.textContent.trim();if(txt.toLowerCase()==='lightvisual'||txt.toLowerCase()==='.studio')el.textContent=txt.toLowerCase()==='lightvisual'?'${BRAND_NAME}':'';if(/^[0-9\\.]+đ$/i.test(txt)){const p=el.closest('button,a,div');if(p)p.style.display='none';el.style.display='none'}if(f.some(i=>txt===i||txt.includes('Vào Nhóm Zalo')||txt.includes('Gói Vô Hạn'))){(el.closest('a,button')||el).style.display='none'}}})}c();new MutationObserver(c).observe(document.documentElement,{childList:true,subtree:true})})();</script>`;

            return {
                statusCode: response.status,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                body: html.replace('</body>', shield + '</body>')
            };
        }

        const arrayBuffer = await response.arrayBuffer();
        return {
            statusCode: response.status,
            headers: { 'content-type': contentType },
            body: Buffer.from(arrayBuffer).toString('base64'),
            isBase64Encoded: true
        };
    } catch (err) {
        return { statusCode: 502, body: 'Lỗi kết nối Server gốc' };
    }
};