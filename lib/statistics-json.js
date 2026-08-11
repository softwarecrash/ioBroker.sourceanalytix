'use strict';

const BASIC_PERIODS = {
	'01_currentDay': ['current', 'day'],
	'02_currentWeek': ['current', 'week'],
	'03_currentMonth': ['current', 'month'],
	'04_currentQuarter': ['current', 'quarter'],
	'05_currentYear': ['current', 'year'],
	'01_previousDay': ['previous', 'day'],
	'02_previousWeek': ['previous', 'week'],
	'03_previousMonth': ['previous', 'month'],
	'04_previousQuarter': ['previous', 'quarter'],
	'05_previousYear': ['previous', 'year'],
};

const FLAT_VIEWS = {
	currentWeek: {
		collection: 'weekdays',
		count: 7,
		getKey: index => String(index + 1),
		getLabelDate: index => new Date(Date.UTC(2020, 0, 6 + index)),
		labelType: 'weekday',
	},
	currentYear: {
		collection: 'months',
		count: 12,
		getKey: index => String(index + 1).padStart(2, '0'),
		getLabelDate: index => new Date(Date.UTC(2020, index, 1)),
		labelType: 'month',
	},
};

const TOTAL_LABELS = {
	de: 'Summe',
	en: 'Total',
	es: 'Total',
	fr: 'Total',
	it: 'Totale',
	nl: 'Totaal',
	pl: 'Suma',
	pt: 'Total',
	ru: '\u0418\u0442\u043e\u0433\u043e',
	uk: '\u0420\u0430\u0437\u043e\u043c',
	zh: '\u603b\u8ba1',
};

/**
 * @param {boolean} enabled - Whether the section is enabled
 * @param {object} options - Period collection settings
 * @returns {object|null} Empty statistics section
 */
function createValueSection(enabled, options) {
	if (!enabled) return null;
	return {
		current: {
			day: null,
			week: null,
			month: null,
			quarter: null,
			year: null,
		},
		previous: options.previous ? {
			day: null,
			week: null,
			month: null,
			quarter: null,
			year: null,
		} : null,
		periods: {
			weekdays: options.days ? {} : null,
			previousWeekdays: options.days && options.previous ? {} : null,
			weeks: options.weeks ? {} : null,
			months: options.months ? {} : null,
			quarters: options.quarters ? {} : null,
		},
	};
}

/**
 * Create an empty, stable statistics JSON structure.
 * @param {object} options - Source and adapter configuration
 * @returns {object} Statistics snapshot
 */
function createStatisticsSnapshot(options) {
	const periods = {
		days: options.days === true,
		weeks: options.weeks === true,
		months: options.months === true,
		quarters: options.quarters === true,
		previous: options.previous === true,
	};
	const quantityValues = createValueSection(options.consumption === true, periods);
	const financialValues = createValueSection(options.costs === true, periods);
	const meterReadings = createValueSection(options.meterValues === true, periods);
	if (meterReadings) {
		meterReadings.current = null;
	}
	const quantity = quantityValues ? {
		type: options.quantityType,
		...quantityValues,
	} : null;
	const financial = financialValues ? {
		type: options.financialType,
		currency: options.currency,
		...financialValues,
	} : null;

	return {
		schemaVersion: 1,
		year: options.year,
		source: {
			id: options.sourceId,
			name: normalizeName(options.sourceName),
			unit: options.unit,
		},
		quantity,
		financial,
		meterReadings,
	};
}

/**
 * @param {unknown} name - ioBroker common.name value
 * @returns {string} Display name
 */
function normalizeName(name) {
	if (typeof name === 'string') return name;
	if (name && typeof name === 'object') {
		const translatedName = Reflect.get(name, 'en') || Reflect.get(name, 'de')
			|| Object.values(name).find(value => typeof value === 'string');
		return typeof translatedName === 'string' ? translatedName : '';
	}
	return '';
}

/**
 * @param {unknown} value - State value
 * @returns {number|null} Numeric value
 */
function normalizeValue(value) {
	if (value === null || value === undefined || value === '') return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

/**
 * @param {unknown} language - Configured ioBroker language
 * @returns {string} Locale supported by the current Node.js runtime
 */
function normalizeLocale(language) {
	const locale = typeof language === 'string' && language.trim()
		? language.trim().replace('_', '-')
		: 'en';
	try {
		new Intl.DateTimeFormat(locale).format();
		return locale;
	} catch {
		return 'en';
	}
}

/**
 * @param {object|null} section - Quantity or financial snapshot section
 * @param {string} collection - Period collection name
 * @returns {object|null} Period values when the collection is enabled
 */
function getPeriodValues(section, collection) {
	const values = section && section.periods && section.periods[collection];
	return values && typeof values === 'object' && !Array.isArray(values) ? values : null;
}

/**
 * @param {object|null} section - Quantity or financial snapshot section
 * @param {string} collection - Period collection name
 * @param {string} key - Language-neutral period key
 * @returns {number} Widget-compatible numeric value
 */
function getFlatPeriodValue(section, collection, key) {
	const values = getPeriodValues(section, collection);
	return normalizeValue(values && values[key]) ?? 0;
}

/**
 * @param {object|null} section - Quantity or financial snapshot section
 * @param {string} collection - Period collection name
 * @returns {number} Sum of the values represented by the visible rows
 */
function getFlatTotal(section, collection) {
	const values = getPeriodValues(section, collection);
	const total = values
		? Object.values(values).reduce((sum, value) => sum + (normalizeValue(value) ?? 0), 0)
		: 0;
	return Number(total.toPrecision(15));
}

/**
 * Create a flat array for generic VIS JSON table widgets.
 * @param {object} snapshot - Statistics snapshot
 * @param {'currentWeek'|'currentYear'} viewName - Requested table view
 * @param {string} [language] - Language used for display labels
 * @returns {{date: string, value: number, price: number}[]} Flat table rows
 */
function createFlatStatisticsView(snapshot, viewName, language = 'en') {
	const view = FLAT_VIEWS[viewName];
	if (!view) return [];
	const quantityValues = getPeriodValues(snapshot && snapshot.quantity, view.collection);
	const financialValues = getPeriodValues(snapshot && snapshot.financial, view.collection);
	if (!quantityValues && !financialValues) return [];

	const locale = normalizeLocale(language);
	const formatter = view.labelType === 'weekday'
		? new Intl.DateTimeFormat(locale, {weekday: 'long', timeZone: 'UTC'})
		: new Intl.DateTimeFormat(locale, {month: 'long', timeZone: 'UTC'});
	const rows = [];
	for (let index = 0; index < view.count; index++) {
		const key = view.getKey(index);
		rows.push({
			date: formatter.format(view.getLabelDate(index)),
			value: getFlatPeriodValue(snapshot.quantity, view.collection, key),
			price: getFlatPeriodValue(snapshot.financial, view.collection, key),
		});
	}
	const baseLanguage = locale.toLowerCase().split('-')[0];
	rows.push({
		date: TOTAL_LABELS[baseLanguage] || TOTAL_LABELS.en,
		value: getFlatTotal(snapshot.quantity, view.collection),
		price: getFlatTotal(snapshot.financial, view.collection),
	});
	return rows;
}

/**
 * @param {string} collection - Internal collection name
 * @param {string} stateName - Internal state name
 * @returns {string|null} Language-neutral period key
 */
function getPeriodKey(collection, stateName) {
	if (collection === 'currentWeek' || collection === 'previousWeek') {
		const match = stateName.match(/^0?([1-7])_/);
		return match ? match[1] : null;
	}
	if (collection === 'weeks') {
		const match = stateName.match(/^(\d{1,2})/);
		return match ? match[1].padStart(2, '0') : null;
	}
	if (collection === 'months') {
		const match = stateName.match(/^(\d{1,2})/);
		return match ? match[1].padStart(2, '0') : null;
	}
	if (collection === 'quarters') {
		const match = stateName.match(/^Q?([1-4])$/);
		return match ? match[1] : null;
	}
	return null;
}

/**
 * Apply one existing SourceAnalytix state to a statistics snapshot.
 * @param {object} snapshot - Mutable statistics snapshot
 * @param {string} relativePath - Path below the source device
 * @param {unknown} value - State value
 * @returns {boolean} Whether the path belongs to the snapshot
 */
function applyStatisticsState(snapshot, relativePath, value) {
	const normalizedValue = normalizeValue(value);
	if (relativePath === 'cumulativeReading') {
		if (!snapshot.meterReadings) return false;
		snapshot.meterReadings.current = normalizedValue;
		return true;
	}

	const match = relativePath.match(/^currentYear\.(consumed|delivered|costs|earnings|meterReadings)\.(.+)$/);
	if (!match) return false;

	const [, category, suffix] = match;
	const section = category === 'consumed' || category === 'delivered'
		? snapshot.quantity
		: category === 'costs' || category === 'earnings'
			? snapshot.financial
			: snapshot.meterReadings;
	if (!section) return false;
	if (category !== 'meterReadings' && section.type !== category) return false;

	const basicPeriod = BASIC_PERIODS[suffix];
	if (basicPeriod) {
		const [group, period] = basicPeriod;
		if (group === 'current' && category === 'meterReadings') return false;
		if (!section[group]) return false;
		section[group][period] = normalizedValue;
		return true;
	}

	const periodMatch = suffix.match(/^(currentWeek|previousWeek|weeks|months|quarters)\.(.+)$/);
	if (!periodMatch) return false;
	const [, collection, stateName] = periodMatch;
	const targetName = collection === 'currentWeek'
		? 'weekdays'
		: collection === 'previousWeek'
			? 'previousWeekdays'
			: collection;
	const target = section.periods[targetName];
	const key = getPeriodKey(collection, stateName);
	if (!target || !key) return false;
	target[key] = normalizedValue;
	return true;
}

/**
 * @param {object} snapshot - Statistics snapshot
 * @returns {string} Serialized state value
 */
function serializeStatisticsSnapshot(snapshot) {
	return JSON.stringify(snapshot);
}

module.exports = {
	applyStatisticsState,
	createFlatStatisticsView,
	createStatisticsSnapshot,
	serializeStatisticsSnapshot,
};
