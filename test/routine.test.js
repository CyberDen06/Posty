import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRoutine, normalizeRoutine, coerceRoutine, WEEKDAYS } from '../lib/routine.js';

test('defaults stay weekly with a single Monday slot', () => {
  const r = defaultRoutine();
  assert.equal(r.cadence, 'weekly');
  assert.deepEqual(r.deliveryDays, ['Monday']);
  assert.equal(r.deliveryDay, 'Monday');
  assert.deepEqual(WEEKDAYS, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
});

test('normalizeRoutine accepts daily cadence and multiple delivery days', () => {
  const r = normalizeRoutine({ cadence: 'daily', deliveryDays: ['Monday', 'Thursday', 'Monday'] }, []);
  assert.equal(r.cadence, 'daily');
  assert.deepEqual(r.deliveryDays, ['Monday', 'Thursday']);
  assert.equal(r.deliveryDay, 'Monday');
});

test('normalizeRoutine filters unknown days and caps at seven', () => {
  const r = normalizeRoutine({ deliveryDays: ['Friday', 'Funday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Saturday', 'Sunday', 'Friday'] }, []);
  assert.deepEqual(r.deliveryDays, ['Friday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Saturday', 'Sunday']);
});

test('normalizeRoutine migrates the legacy single-day form', () => {
  const r = normalizeRoutine({ deliveryDay: 'Friday' }, []);
  assert.deepEqual(r.deliveryDays, ['Friday']);
  assert.equal(r.deliveryDay, 'Friday');
});

test('normalizeRoutine rejects unknown cadences and keeps prior days on empty input', () => {
  assert.equal(normalizeRoutine({ cadence: 'hourly' }, []).cadence, 'weekly');
  const r = normalizeRoutine({ deliveryDays: [], deliveryDay: 'Tuesday' }, []);
  assert.deepEqual(r.deliveryDays, ['Monday']); // empty array: nothing valid to take
  assert.deepEqual(normalizeRoutine({ deliveryDays: ['Wednesday'] }, []).deliveryDays, ['Wednesday']);
});

test('coerceRoutine migrates stored legacy docs without losing settings', () => {
  const legacy = { interests: ['ai'], cadence: 'weekly', deliveryDay: 'Friday', deliveryTime: '08:30', runs: 4, lastRunAt: '2026-11-01T00:00:00Z' };
  const r = coerceRoutine(legacy);
  assert.deepEqual(r.deliveryDays, ['Friday']);
  assert.equal(r.deliveryDay, 'Friday');
  assert.equal(r.runs, 4);
  assert.equal(r.lastRunAt, '2026-11-01T00:00:00Z');
  assert.equal(r.deliveryTime, '08:30');
  assert.deepEqual(coerceRoutine(null).deliveryDays, ['Monday']);
  assert.equal(coerceRoutine({ cadence: 'minutely' }).cadence, 'weekly');
  assert.deepEqual(coerceRoutine({ deliveryDays: ['Nope'] }).deliveryDays, ['Monday']);
});
