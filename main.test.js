'use strict';

const assert = require('node:assert/strict');
const {
	calculatePriceDelta,
	getPriceForTimestamp,
	normalizeDynamicCostMemory,
	normalizePriceHistory,
	parsePriceValue,
} = require('./lib/dynamic-pricing');

const minute = 60_000;
const at = (hour, minutes = 0) => Date.UTC(2026, 0, 1, hour, minutes);

describe('dynamic pricing', () => {
	describe('parsePriceValue', () => {
		it('accepts numbers and decimal commas', () => {
			assert.equal(parsePriceValue(0.25), 0.25);
			assert.equal(parsePriceValue('0,40'), 0.4);
		});

		it('rejects empty and non-numeric values', () => {
			assert.equal(parsePriceValue(''), null);
			assert.equal(parsePriceValue('invalid'), null);
			assert.equal(parsePriceValue(false), null);
		});
	});

	describe('normalizePriceHistory', () => {
		it('sorts entries and removes invalid, duplicate and unchanged prices', () => {
			const history = normalizePriceHistory([
				{ts: at(11), price: '0,40'},
				{ts: 0, price: 99},
				{ts: at(10), price: 0.25},
				{ts: at(10), price: 0.3},
				{ts: at(10, 30), price: 0.3},
				{ts: at(12), price: 'invalid'},
			]);

			assert.deepEqual(history, [
				{ts: at(10), price: 0.3},
				{ts: at(11), price: 0.4},
			]);
		});
	});

	describe('getPriceForTimestamp', () => {
		const history = [
			{ts: at(10), price: 0.25},
			{ts: at(11), price: 0.4},
		];

		it('uses the price valid at the consumption timestamp', () => {
			assert.equal(getPriceForTimestamp(history, at(10, 30)), 0.25);
			assert.equal(getPriceForTimestamp(history, at(11)), 0.4);
			assert.equal(getPriceForTimestamp(history, at(11, 30)), 0.4);
		});

		it('uses a configured fallback before the first known price', () => {
			assert.equal(getPriceForTimestamp(history, at(9, 30), 0.2), 0.2);
		});
	});

	describe('calculatePriceDelta', () => {
		const history = [
			{ts: at(10), price: 0.25},
			{ts: at(11), price: 0.4},
			{ts: at(12), price: 0.5},
		];

		it('prices consumption within each historical interval', () => {
			assert.equal(calculatePriceDelta(history, 1, at(10), at(10, 30)), 0.25);
			assert.equal(calculatePriceDelta(history, 1, at(11), at(11, 30)), 0.4);
			assert.equal(calculatePriceDelta(history, 1, at(12), at(12, 30)), 0.5);
		});

		it('keeps a price change at the reading endpoint out of the preceding interval', () => {
			assert.equal(calculatePriceDelta(history, 1, at(10, 45), at(11)), 0.25);
		});

		it('splits a meter delta proportionally over 15-minute price intervals', () => {
			const quarterHourlyHistory = [
				{ts: at(10), price: 0.2},
				{ts: at(10, 15), price: 0.3},
				{ts: at(10, 30), price: 0.4},
				{ts: at(10, 45), price: 0.5},
			];

			assert.equal(calculatePriceDelta(quarterHourlyHistory, 4, at(10), at(11)), 1.4);
		});

		it('does not change previously accumulated costs when a later price is added', () => {
			const initialHistory = history.slice(0, 2);
			const costAt1030 = calculatePriceDelta(initialHistory, 1, at(10), at(10, 30));
			const costAt1130 = calculatePriceDelta(initialHistory, 1, at(11), at(11, 30));
			if (costAt1030 === null || costAt1130 === null) assert.fail('Expected historical prices');
			const historicalTotal = costAt1030 + costAt1130;

			const extendedHistory = [...initialHistory, {ts: at(12), price: 0.5}];
			assert.equal(costAt1030, 0.25);
			assert.equal(costAt1130, 0.4);
			assert.equal(historicalTotal, 0.65);
			assert.equal(calculatePriceDelta(extendedHistory, 1, at(12), at(12, 30)), 0.5);
		});

		it('produces the same result after persisted history is restored', () => {
			const restoredHistory = normalizePriceHistory(JSON.parse(JSON.stringify(history)));
			assert.equal(calculatePriceDelta(restoredHistory, 2, at(10, 30), at(11, 30)), 0.65);
		});

		it('falls back to the price at the reading for missing interval timestamps', () => {
			assert.equal(calculatePriceDelta(history, 2, null, at(11, 30)), 0.8);
			assert.equal(calculatePriceDelta([], 2, null, at(11, 30)), null);
		});

		it('handles millisecond intervals without rounding the result', () => {
			const shortHistory = [
				{ts: at(10), price: 0.2},
				{ts: at(10) + minute, price: 0.4},
			];
			const result = calculatePriceDelta(shortHistory, 2, at(10), at(10) + 2 * minute);
			if (result === null) assert.fail('Expected a calculated price delta');
			assert.ok(Math.abs(result - 0.6) < 1e-12);
		});
	});

	describe('normalizeDynamicCostMemory', () => {
		const preciseMemory = {
			version: 1,
			priceDefinition: 'Electricity',
			lastReading: 7837.556,
			lastTs: at(11),
			totals: {
				priceDay: 0.960789,
				priceWeek: 0.960789,
				priceMonth: 1.340789,
				priceQuarter: 1.340789,
				priceYear: 1.340789,
			},
		};

		it('preserves unrounded costs through a JSON restart round-trip', () => {
			const restoredMemory = normalizeDynamicCostMemory(JSON.parse(JSON.stringify(preciseMemory)));
			assert.deepEqual(restoredMemory, preciseMemory);
		});

		it('continues from precise totals after a restart', () => {
			const restoredMemory = normalizeDynamicCostMemory(JSON.parse(JSON.stringify(preciseMemory)));
			if (!restoredMemory) assert.fail('Expected valid persisted memory');

			const history = [
				{ts: at(10), price: 0.25},
				{ts: at(11), price: 0.4},
			];
			const priceDelta = calculatePriceDelta(history, 1, at(10, 30), at(11, 30));
			if (priceDelta === null) assert.fail('Expected a calculated price delta');

			assert.equal(priceDelta, 0.325);
			assert.equal(restoredMemory.totals.priceDay + priceDelta, 1.285789);
		});

		it('rejects incompatible versions and incomplete totals', () => {
			assert.equal(normalizeDynamicCostMemory({...preciseMemory, version: 2}), null);
			assert.equal(normalizeDynamicCostMemory({...preciseMemory, totals: {priceDay: 1}}), null);
			assert.equal(normalizeDynamicCostMemory(null), null);
		});
	});
});
