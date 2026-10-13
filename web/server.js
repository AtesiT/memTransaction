/*
 * server.js — локальный веб-сервер для лабораторной работы.
 * ===========================================================================
 * Зачем нужен сервер, а не просто открыть index.html:
 *
 *  1) Web Workers и модули не работают по схеме file://;
 *  2) чтобы браузер разрешил SharedArrayBuffer (настоящая общая память для
 *     потоков), страница должна быть «cross-origin isolated». Для этого сервер
 *     отдаёт два заголовка:
 *         Cross-Origin-Opener-Policy:   same-origin
 *         Cross-Origin-Embedder-Policy: require-corp
 *     Без них приложение автоматически переключается в режим симулятора.
 *
 * Запуск:  node server.js  [порт]
 * ===========================================================================
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');

var PORT = Number(process.argv[2] || process.env.PORT || 8080);
var ROOT = __dirname;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

var server = http.createServer(function (req, res) {
  var urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  var filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ''));
  if (filePath.indexOf(ROOT) !== 0) {                 // защита от выхода из каталога
    res.writeHead(403);
    res.end('403');
    return;
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — файл не найден: ' + urlPath);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      // Именно эти два заголовка включают SharedArrayBuffer + Atomics.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin'
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('Транзакционная память — лабораторный стенд');
  console.log('Открой: http://localhost:' + PORT);
  console.log('Режим настоящих потоков включится, если браузер разрешит SharedArrayBuffer');
  console.log('(сервер отдаёт заголовки COOP/COEP). Иначе — автоматический симулятор.');
});
