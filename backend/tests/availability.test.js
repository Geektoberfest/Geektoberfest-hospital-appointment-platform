const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Availability = require('../models/Availability');

describe('Availability Engine & Break Exclusions', () => {
  describe('getSlots() dynamic computation and break exclusions', () => {
    test('computes consecutive slots when no breaks are defined', () => {
      const avail = new Availability({
        doctor: new mongoose.Types.ObjectId(),
        date: '2026-10-15',
        startTime: '09:00',
        endTime: '11:00',
        slotDuration: 30,
        breaks: [],
      });

      const slots = avail.getSlots();
      assert.equal(slots.length, 4);
      assert.deepEqual(slots, [
        { startTime: '09:00', endTime: '09:30' },
        { startTime: '09:30', endTime: '10:00' },
        { startTime: '10:00', endTime: '10:30' },
        { startTime: '10:30', endTime: '11:00' },
      ]);
    });

    test('excludes slots that overlap with lunch break', () => {
      const avail = new Availability({
        doctor: new mongoose.Types.ObjectId(),
        isRecurring: true,
        daysOfWeek: [1, 2, 3, 4, 5],
        startTime: '10:00',
        endTime: '15:00',
        slotDuration: 60,
        breaks: [
          { label: 'Lunch', startTime: '12:00', endTime: '13:00' },
        ],
      });

      const slots = avail.getSlots();
      // Total 5 hours: 10-11, 11-12, 12-13 (excluded), 13-14, 14-15
      assert.equal(slots.length, 4);
      assert.deepEqual(slots, [
        { startTime: '10:00', endTime: '11:00' },
        { startTime: '11:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '14:00' },
        { startTime: '14:00', endTime: '15:00' },
      ]);
    });

    test('excludes slots for multiple breaks and partial overlap', () => {
      const avail = new Availability({
        doctor: new mongoose.Types.ObjectId(),
        startTime: '09:00',
        endTime: '13:00',
        slotDuration: 30,
        breaks: [
          { label: 'Tea', startTime: '10:15', endTime: '10:45' }, // Overlaps 10:00-10:30 and 10:30-11:00
          { label: 'Debrief', startTime: '12:00', endTime: '12:30' },
        ],
      });

      const slots = avail.getSlots();
      const startTimes = slots.map((s) => s.startTime);
      // Expected without breaks: 09:00, 09:30, 10:00, 10:30, 11:00, 11:30, 12:00, 12:30
      // 10:15-10:45 overlaps with 10:00-10:30 and 10:30-11:00
      // 12:00-12:30 overlaps with 12:00-12:30
      assert.equal(startTimes.includes('10:00'), false);
      assert.equal(startTimes.includes('10:30'), false);
      assert.equal(startTimes.includes('12:00'), false);
      assert.equal(startTimes.includes('09:00'), true);
      assert.equal(startTimes.includes('09:30'), true);
      assert.equal(startTimes.includes('11:00'), true);
      assert.equal(startTimes.includes('11:30'), true);
      assert.equal(startTimes.includes('12:30'), true);
    });
  });

  describe('Availability.findSlot() matching', () => {
    const origFind = Availability.find;

    afterEach(() => {
      Availability.find = origFind;
    });

    test('finds slot matching specific single-date availability', async () => {
      const doctorId = new mongoose.Types.ObjectId();
      const mockDoc = new Availability({
        doctor: doctorId,
        date: '2026-10-15',
        startTime: '09:00',
        endTime: '11:00',
        slotDuration: 30,
        isRecurring: false,
        isActive: true,
      });

      Availability.find = async (query) => {
        if (query.date === '2026-10-15' && query.isRecurring?.$ne === true) {
          return [mockDoc];
        }
        return [];
      };

      const result = await Availability.findSlot(doctorId, '2026-10-15', '09:30');
      assert.ok(result);
      assert.equal(result.slot.startTime, '09:30');
      assert.equal(result.slot.endTime, '10:00');
    });

    test('finds slot matching weekly recurring availability', async () => {
      const doctorId = new mongoose.Types.ObjectId();
      // 2026-10-12 is Monday -> UTC day of week = 1
      const mockDoc = new Availability({
        doctor: doctorId,
        isRecurring: true,
        daysOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
        startTime: '14:00',
        endTime: '18:00',
        slotDuration: 60,
        breaks: [{ label: 'Break', startTime: '16:00', endTime: '17:00' }],
        isActive: true,
      });

      Availability.find = async (query) => {
        if (query.isRecurring === true && query.daysOfWeek === 1) {
          return [mockDoc];
        }
        return [];
      };

      const match = await Availability.findSlot(doctorId, '2026-10-12', '15:00');
      assert.ok(match);
      assert.equal(match.slot.startTime, '15:00');
      assert.equal(match.slot.endTime, '16:00');

      // 16:00 is during break -> must return null
      const breakMatch = await Availability.findSlot(doctorId, '2026-10-12', '16:00');
      assert.equal(breakMatch, null);
    });

    test('respects startDate and endDate constraints on recurring schedules', async () => {
      const doctorId = new mongoose.Types.ObjectId();
      const mockDoc = new Availability({
        doctor: doctorId,
        isRecurring: true,
        daysOfWeek: [1],
        startDate: '2026-10-01',
        endDate: '2026-10-20',
        startTime: '09:00',
        endTime: '12:00',
        slotDuration: 30,
        isActive: true,
      });

      Availability.find = async (query) => {
        if (query.isRecurring === true && query.daysOfWeek === 1) {
          return [mockDoc];
        }
        return [];
      };

      // 2026-10-12 is within [2026-10-01, 2026-10-20]
      const inside = await Availability.findSlot(doctorId, '2026-10-12', '09:00');
      assert.ok(inside);

      // 2026-10-26 is Monday but after endDate 2026-10-20
      const outside = await Availability.findSlot(doctorId, '2026-10-26', '09:00');
      assert.equal(outside, null);
    });
  });
});
