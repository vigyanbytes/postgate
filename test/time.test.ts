import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatInZone, isTimeZone, offsetMinutes, parseScheduleTime } from '../src/posts/time.ts';

describe('schedule times', () => {
  it('reads wall-clock input in UTC by default, or in the given zone', () => {
    assert.equal(parseScheduleTime('2026-10-26T09:30')!.toISOString(), '2026-10-26T09:30:00.000Z');
    assert.equal(parseScheduleTime('2026-10-26T09:30', 'Asia/Kolkata')!.toISOString(), '2026-10-26T04:00:00.000Z');
    assert.equal(parseScheduleTime('2026-10-26 09:30:15', 'Asia/Kolkata')!.toISOString(), '2026-10-26T04:00:15.000Z');
  });
  it('honours explicit offsets and other zones, including DST', () => {
    assert.equal(parseScheduleTime('2026-10-26T09:30:00Z')!.toISOString(), '2026-10-26T09:30:00.000Z');
    assert.equal(parseScheduleTime('2026-10-26T09:30+05:30', 'America/New_York')!.toISOString(), '2026-10-26T04:00:00.000Z');
    assert.equal(parseScheduleTime('2026-07-01T09:00', 'Europe/London')!.toISOString(), '2026-07-01T08:00:00.000Z');
    assert.equal(parseScheduleTime('2026-12-01T09:00', 'Europe/London')!.toISOString(), '2026-12-01T09:00:00.000Z');
    assert.equal(offsetMinutes(new Date('2026-10-26T00:00:00Z'), 'Asia/Kolkata'), 330);
  });
  it('rejects junk and formats back into the zone', () => {
    assert.equal(parseScheduleTime('next monday'), null);
    assert.equal(isTimeZone('Asia/Kolkata'), true);
    assert.equal(isTimeZone('Mars/Olympus'), false);
    assert.equal(formatInZone(new Date('2026-10-26T04:00:00Z')), '2026-10-26T04:00:00+00:00');
    assert.equal(formatInZone(new Date('2026-10-26T04:00:00Z'), 'Asia/Kolkata'), '2026-10-26T09:30:00+05:30');
    assert.equal(formatInZone(new Date('2026-10-26T04:00:00Z'), 'America/New_York'), '2026-10-26T00:00:00-04:00');
  });
});
