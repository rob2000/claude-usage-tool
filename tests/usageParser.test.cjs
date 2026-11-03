const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { parseUsageBars } = require('../dist-electron/usageParser.js');

test('reads a session percentage beyond an intervening multiline warning', () => {
  const bars = parseUsageBars([
    'Current session',
    'Usage warning',
    'Your usage is approaching the limit.',
    'Some requests may be limited.',
    'Learn more',
    'Dismiss',
    'Resets in 2 hr 15 min',
    '89% used',
    'Weekly limits',
    'All models',
    'Resets Fri 10:00',
    '42% used',
  ].join('\n'));
  assert.deepEqual(bars.map(bar => [bar.label, bar.percentage, bar.resetInfo]), [
    ['Current session', 89, 'Resets in 2 hr 15 min'],
    ['All models', 42, 'Resets Fri 10:00'],
  ]);
});

test('preserves a zero-percent session without a reset message', () => {
  const bars = parseUsageBars('Current session\n0% used\nAll models\n30% used');
  assert.deepEqual(bars.map(bar => bar.percentage), [0, 30]);
});

test('does not borrow the next section percentage when session data is absent', () => {
  const bars = parseUsageBars('Current session\nResets in 1 hr\nAll models\n62% used');
  assert.deepEqual(bars.map(bar => [bar.label, bar.percentage]), [['All models', 62]]);
});

test('does not fabricate a zero-percent session from a reset message', () => {
  assert.deepEqual(parseUsageBars('Current session\nResets in 1 hr'), []);
});

test('handles German headings, warnings, reset messages, and percentage wording', () => {
  const bars = parseUsageBars([
    'Aktuelle Sitzung', 'Warnung', 'Zeile 1', 'Zeile 2', 'Zeile 3', 'Zeile 4',
    'Wird um 14:00 zurückgesetzt', '95 % verbraucht',
    'Wöchentliche Limits', 'Alle Modelle', 'Zurücksetzung am Freitag', '30% genutzt',
    'Nur Sonnet', '0% verwendet',
  ].join('\n'));
  assert.deepEqual(bars.map(bar => [bar.label, bar.percentage, bar.resetInfo]), [
    ['Aktuelle Sitzung', 95, 'Wird um 14:00 zurückgesetzt'],
    ['Alle Modelle', 30, 'Zurücksetzung am Freitag'],
    ['Nur Sonnet', 0, ''],
  ]);
});

test('retains separate limits with equal percentages in the unlabelled fallback', () => {
  const bars = parseUsageBars('10% used\n10% used');
  assert.deepEqual(bars.map(bar => [bar.label, bar.percentage]), [
    ['Current Session', 10], ['All models', 10],
  ]);
});

test('keeps resets within their section, including reset text after the percentage', () => {
  const bars = parseUsageBars('Current session\n12% used\nResets in 1 hr\nAll models\n23% used\nResets Fri 12:00');
  assert.deepEqual(bars.map(bar => bar.resetInfo), ['Resets in 1 hr', 'Resets Fri 12:00']);
});

test('can run as injected browser JavaScript without module dependencies', () => {
  const bars = vm.runInNewContext(`(${parseUsageBars.toString()})('Aktuelle Session\\n0% verbraucht')`);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].label, 'Aktuelle Session');
  assert.equal(bars[0].percentage, 0);
});

test('returns no data for a login page', () => {
  assert.deepEqual(parseUsageBars('Welcome back\nContinue with Google'), []);
});
