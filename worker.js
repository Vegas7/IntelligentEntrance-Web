// 智能通行 Web 版 —— Cloudflare Workers 版本（可选，与 server.js 功能相同）
// 静态页面由 Workers Static Assets 托管（见 wrangler.toml），/api/* 转发到官方接口。
// 部署: npx wrangler deploy

const UPSTREAM = 'https://www.infoxs.com.cn:15000/building_app_api/';

const ALLOWED = new Set([
  'POST auth/get_token',
  'POST sms_verification/send',
  'POST user/get_user',
  'POST building/read_relation_building_list',
  'POST floor/read_list',
  'POST user/get_default_floor',
  'POST user/modify_default_floor',
  'POST v2/user/get_commuter_code',
]);

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const apiPath = url.pathname.slice(5);
    if (!ALLOWED.has(`${request.method} ${apiPath}`)) {
      return json(404, { value: 404, description: `接口未开放: ${request.method} ${apiPath}` });
    }

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const auth = request.headers.get('Authorization');
    if (auth) {
      headers.Authorization = auth;
      headers.Token = auth;
    }

    try {
      const up = await fetch(UPSTREAM + apiPath, {
        method: request.method,
        headers,
        body: request.method === 'GET' ? undefined : await request.text(),
      });
      return new Response(up.body, {
        status: up.status,
        headers: {
          'Content-Type': up.headers.get('Content-Type') || 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    } catch (e) {
      return json(502, { value: 502, description: `代理请求失败: ${e.message}` });
    }
  },
};
