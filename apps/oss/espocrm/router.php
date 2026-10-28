<?php
// Router for `php -S` serving EspoCRM natively (apps/oss/espocrm/start.ps1). Mirrors the Apache setup in
// EspoCRM's docs: document root public/, /client/ aliased to the app's client/ folder, /api/v1/* to
// public/api/v1/index.php. Usage: php -S 127.0.0.1:8090 -t <app>/public router.php (ESPO_APP = <app>).

$app = getenv('ESPO_APP');
$public = $app . DIRECTORY_SEPARATOR . 'public';
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/');

$types = [
    'js' => 'application/javascript', 'mjs' => 'application/javascript', 'css' => 'text/css',
    'json' => 'application/json', 'svg' => 'image/svg+xml', 'png' => 'image/png', 'jpg' => 'image/jpeg',
    'gif' => 'image/gif', 'ico' => 'image/x-icon', 'woff' => 'font/woff', 'woff2' => 'font/woff2',
    'ttf' => 'font/ttf', 'eot' => 'application/vnd.ms-fontobject', 'map' => 'application/json',
    'html' => 'text/html', 'tpl' => 'text/html', 'txt' => 'text/plain',
];

function serveFile(string $file, array $types): bool
{
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
    header('Content-Length: ' . filesize($file));
    header('Cache-Control: max-age=3600');
    readfile($file);
    return true;
}

if (str_starts_with($uri, '/client/')) {
    $base = realpath($app . DIRECTORY_SEPARATOR . 'client');
    $file = realpath($app . str_replace('/', DIRECTORY_SEPARATOR, $uri));
    if ($file !== false && $base !== false && str_starts_with($file, $base) && is_file($file)) {
        return serveFile($file, $types);
    }
    http_response_code(404);
    return true;
}

if (str_starts_with($uri, '/api/v1/') || $uri === '/api/v1') {
    $script = $public . '/api/v1/index.php';
    $_SERVER['SCRIPT_NAME'] = '/api/v1/index.php';
    $_SERVER['SCRIPT_FILENAME'] = $script;
    $_SERVER['PHP_SELF'] = '/api/v1/index.php';
    chdir(dirname($script));
    require $script;
    return true;
}

$static = realpath($public . str_replace('/', DIRECTORY_SEPARATOR, $uri));
if ($uri !== '/' && $static !== false && is_file($static) && !str_ends_with($static, '.php')) {
    return serveFile($static, $types);
}

$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = $public . '/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
chdir($public);
require $public . '/index.php';
return true;
