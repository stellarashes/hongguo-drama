const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const cli = require('./download.cjs');

assert.deepEqual([...cli.parseEpisodeSelection('1-3,5')], [1, 2, 3, 5]);
assert.deepEqual([...cli.parseEpisodeSelection('2，4')], [2, 4]);
assert.throws(() => cli.parseEpisodeSelection('0'));
assert.throws(() => cli.parseEpisodeSelection('3-1'));
assert.throws(() => cli.parseEpisodeSelection('x'));

assert.equal(cli.sanitizeFolderName('A/B:C'), 'ABC');
assert.equal(cli.uniqueEpisodeFilename('测试剧', { index: 7, title: '开局' }), '测试剧 007.mp4');
assert.equal(cli.uniqueEpisodeFilename('测试剧', { index: 7, title: '' }), '测试剧 007.mp4');

const seriesId = '123456789';
const suffix = crypto.createHash('sha256').update(seriesId).digest('hex').slice(0, 12);
assert.equal(cli.seriesDownloadDir('/tmp/root', seriesId, 'A/B:C'),
  path.join('/tmp/root', `ABC-${suffix}`));
assert.equal(cli.seriesDownloadDir('/tmp/root', 'hema:abc', '标题'),
  path.join('/tmp/root', `标题-${crypto.createHash('sha256').update('hema:abc').digest('hex').slice(0, 12)}`));

assert.equal(cli.isHls({ url: 'https://example.com/a.m3u8?token=1' }), true);
assert.equal(cli.isHls({ url: 'https://example.com/a.mp4' }), false);
assert.equal(cli.isHls({ format: 'hls', url: 'https://example.com/a' }), true);

const options = cli.parseArgs(['123456789', '--episodes', '1-2', '--quality', '720p', '--out', '/tmp/out', '--concurrency', '2', '--overwrite']);
assert.equal(options.input, '123456789');
assert.equal(options.quality, '720p');
assert.equal(options.out, path.resolve('/tmp/out'));
assert.equal(options.concurrency, 2);
assert.equal(options.overwrite, true);
assert.deepEqual([...options.episodes], [1, 2]);
assert.equal(cli.parseArgs(['--help']).help, true);
assert.throws(() => cli.parseArgs(['--quality', '4k', 'abc']));
assert.throws(() => cli.parseArgs(['--concurrency', '11', 'abc']));
assert.throws(() => cli.parseArgs(['--all', '--episodes', '1', 'abc']));

console.log('download-cli: 参数、命名与 HLS 识别检查通过');
