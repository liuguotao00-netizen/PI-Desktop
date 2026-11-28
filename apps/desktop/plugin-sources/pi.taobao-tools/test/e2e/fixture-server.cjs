"use strict";

/**
 * Local fixture pages for the browser E2E suite.
 *
 * They exercise the same surfaces the platform scripts rely on: a closed
 * shadow root, a hidden file input, a contenteditable editor, an XHR/fetch
 * response to capture, a publish fetch whose JSON is the receipt, and a
 * captcha page.
 */

const http = require("node:http");

const HOME = `<!doctype html>
<html><body>
  <input id="file" type="file" />
  <div id="thumb"></div>
  <div id="editor" contenteditable="true"></div>
  <xhs-publish-btn></xhs-publish-btn>
  <div id="items"></div>
  <script>
    document.getElementById('file').addEventListener('change', () => {
      if (document.getElementById('thumb')) return;
      const thumb = document.createElement('div');
      thumb.id = 'thumb';
      thumb.textContent = 'uploaded';
      document.body.appendChild(thumb);
    });
    class PublishButton extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'closed' });
        root.innerHTML = '<button id="publish">发布</button>';
        root.getElementById('publish').addEventListener('click', async () => {
          const response = await fetch('/api/publish', { method: 'POST' });
          window.__published = await response.json();
        });
      }
    }
    customElements.define('xhs-publish-btn', PublishButton);
    setTimeout(() => {
      const box = document.getElementById('items');
      for (let index = 0; index < 5; index += 1) {
        const item = document.createElement('div');
        item.className = 'item';
        item.dataset.id = String(index);
        box.appendChild(item);
      }
    }, 200);
    setTimeout(() => { fetch('/api/data').catch(() => {}); }, 350);
  </script>
</body></html>`;

const CAPTCHA = `<!doctype html>
<html><body><p>请完成下方验证</p></body></html>`;

const LIST = `<!doctype html>
<html><body>
  <div id="results"></div>
  <script>
    setTimeout(() => { fetch('/api/data').catch(() => {}); }, 350);
  </script>
</body></html>`;

function json(response, payload) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function startFixture() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/publish") {
      json(response, { success: true, noteId: "note-1" });
      return;
    }
    if (url.pathname === "/api/data") {
      json(response, {
        items: [{ id: "a" }, { id: "b" }, { id: "c" }],
        hasNext: false,
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/captcha") response.end(CAPTCHA);
    else if (url.pathname === "/list") response.end(LIST);
    else response.end(HOME);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startFixture };
