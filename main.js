/* eslint-disable no-mixed-spaces-and-tabs */
'use strict';

/*
 * Created with @ioBroker/create-adapter v1.11.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const adapterHelpers = require('iobroker-adapter-helpers'); // Lib used for Unit calculations
const schedule = require('cron').CronJob; // Cron Scheduler

// Sentry error reporting, disable when testing alpha source code locally!
const disableSentry = false;

// Store all days and months
const basicStates = ['01_currentDay', '02_currentWeek', '03_currentMonth', '04_currentQuarter', '05_currentYear'];
const basicPreviousStates = ['01_previousDay', '02_previousWeek', '03_previousMonth', '04_previousQuarter', '05_previousYear'];
const weekdays = JSON.parse('["07_Sunday","01_Monday","02_Tuesday","03_Wednesday","04_Thursday","05_Friday","06_Saturday"]');
const months = JSON.parse('["01_January","02_February","03_March","04_April","05_May","06_June","07_July","08_August","09_September","10_October","11_November","12_December"]');
const stateDeletion = true, previousCalculationRounded = {};
const storeSettings = {};
let calcBlock = null; // Global variable to block all calculations
let delay = null; // Global array for all running timers
let useCurrency = null;

// Create variables for object arrays
const actualDate = {}; //, currentDay = null;

class Sourceanalytix extends utils.Adapter {
	/**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
	constructor(options) {
		// @ts-ignore
		super({
			...options,
			name: 'sourceanalytix',
		});

		this.on('ready', this.onReady.bind(this));
		this.on('objectChange', this.onObjectChange.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));

		// Unit and price definitions, will be loaded at adapter start.
		this.unitPriceDef = {
			unitConfig: {},
			pricesConfig: {}
		};
		this.activeStates = {}; // Array of activated states for SourceAnalytix
		this.dynamicPriceStates = {}; // Dynamic price state ID -> price definition categories
		this.priceHistories = {}; // Price definition category -> ordered dynamic price history
		this.validStates = {}; // Array of all created states
		this.visWidgetJson ={}; // Array containing all calculation values to use in vis widget
	}

	/**
     * Is called when databases are connected and adapter received configuration.
     */
	async onReady() {
		try {

			this.log.info('Welcome to SourceAnalytix, making things ready ... ');

			// Block all calculation functions during startup
			calcBlock = true;

			// Get system currency, use € as fallback in case of errors
			const sys_conf = await this.getForeignObjectAsync('system.config');
			if (sys_conf && sys_conf.common.currency){
				useCurrency = sys_conf.common.currency;
			} else {
				useCurrency = '€';
			}

			// Load Unit definitions from helper library & prices from admin to workable memory array
			await this.definitionLoader();

			// Store current data/time information to memory
			await this.refreshDates();

			// Load setting for Year statistics from admin settings
			storeSettings.storeWeeks = this.config.store_weeks;
			storeSettings.storeMonths = this.config.store_months;
			storeSettings.storeQuarters = this.config.store_quarters;

			// Get all objects with custom configuration items
			const customStateArray = await this.getObjectViewAsync('system', 'custom', {});
			this.log.debug(`All states with custom items : ${JSON.stringify(customStateArray)}`);

			// List all states with custom configuration
			if (customStateArray && customStateArray.rows) {	// Verify first if result is not empty

				// Loop truth all states and check if state is activated for SourceAnalytix
				for (const index in customStateArray.rows) {

					if (customStateArray.rows[index].value) { // Avoid crash if object is null or empty

						// Check if custom object contains data for SourceAnalytix
						// @ts-ignore
						if (customStateArray.rows[index].value[this.namespace]){

							// Simplify stateID
							const stateID = customStateArray.rows[index].id;
							this.log.debug(`SourceAnalytix configuration found for ${stateID}`);

							// Check if custom object is enabled for SourceAnalytix
							// @ts-ignore
							if(customStateArray.rows[index].value[this.namespace].enabled){
								// Prepare array in constructor for further processing
								this.activeStates[stateID] = {};
								this.log.debug(`SourceAnalytix enabled state found ${stateID}`);
							} else {
								this.log.debug(`SourceAnalytix configuration found but not Enabled, skipping ${stateID}`);
							}

						} else {
							this.log.debug(`No SourceAnalytix configuration found, skipping state`);
						}
					}
				}
			}

			// Prepare memory values to count amount of activated states
			const totalEnabledStates = Object.keys(this.activeStates).length;
			let totalInitiatedStates = 0;
			let totalFailedStates = 0;

			this.log.info(`Found ${totalEnabledStates} SourceAnalytix enabled states`);

			// Initialize all discovered states
			let count = 1;
			for (const stateID in this.activeStates) {
				this.log.info(`Initialising "${stateID}" | (${count} of ${totalEnabledStates})`);

				// Store relevant information into memory to handle calculations
				const memoryReady = await this.buildStateDetailsArray(stateID);

				if (memoryReady) {
					await this.initialize(stateID);
					totalInitiatedStates = totalInitiatedStates + 1;
					this.log.info(`Initialization of ${stateID} successfully`);
				} else {
					this.log.error(`Initialization of ${stateID} failed, check warn messages !`);
					totalFailedStates = totalFailedStates + 1;
				}
				count = count + 1;
			}

			// Start Daily reset function by cron job
			await this.resetStartValues();

			// Subscribe on all foreign objects to detect (de)activation of sourceanalytix enabled states
			this.subscribeForeignObjects('*');

			// Enable all calculations with timeout of 500 ms
			if (delay) {
				clearTimeout(delay);
				delay = null;
			}
			delay = setTimeout(function () {
				calcBlock = false;
			}, 500);

			if (totalFailedStates > 0) {
				this.log.error(`Cannot handle calculations for ${totalFailedStates} of ${totalEnabledStates} enabled states, check error messages`);
				if (totalFailedStates < totalEnabledStates){
					this.log.warn(`Partially activated SourceAnalytix for ${totalInitiatedStates} of ${totalEnabledStates} states, check error messages!`);
				}
			} else {
				this.log.info(`Successfully activated SourceAnalytix for all ${totalInitiatedStates} of ${totalEnabledStates} states, will do my Job until you stop me!`);
			}

			//ToDo: add cleanup for unused states
			// this.cleanupUnused()

		} catch (error) {
			this.errorHandling('[onReady]', error);
		}

	}

	/**
     * Convert configured or state-provided prices to numbers.
     * @param {any} value - Price value from settings or ioBroker state
     * @returns {number | null}
     */
	parsePriceValue(value) {
		if (value === null || value === undefined || value === '') return null;
		if (typeof value === 'number') return Number.isFinite(value) ? value : null;
		if (typeof value === 'string') {
			const parsedValue = Number(value.trim().replace(',', '.'));
			return Number.isFinite(parsedValue) ? parsedValue : null;
		}
		return null;
	}

	/**
     * @param {any} value - Input value
     * @param {number} defaultValue - Fallback for non-numeric values
     * @returns {number}
     */
	getNumberOrDefault(value, defaultValue) {
		const parsedValue = this.parsePriceValue(value);
		return parsedValue === null ? defaultValue : parsedValue;
	}

	/**
     * @param {string} stateID - Source state ID
     * @returns {boolean}
     */
	isDynamicPriceState(stateID) {
		const activeState = this.activeStates[stateID];
		return !!(activeState && activeState.prices && activeState.prices.priceSource === 'state');
	}

	/**
     * @param {any} timestamp - ioBroker timestamp
     * @returns {number}
     */
	getTimestampOrNow(timestamp) {
		const parsedTimestamp = Number(timestamp);
		return Number.isFinite(parsedTimestamp) && parsedTimestamp > 0 ? parsedTimestamp : Date.now();
	}

	/**
     * @param {ioBroker.State | null | undefined} state - ioBroker state
     * @returns {number}
     */
	getStateChangeTimestamp(state) {
		return this.getTimestampOrNow(state && (state.lc || state.ts));
	}

	/**
     * @param {string} priceDefinition - Price definition category
     * @returns {string}
     */
	getPriceHistoryStateName(priceDefinition) {
		return `priceHistory.${priceDefinition.toString().replace(/[^a-zA-Z0-9_-]/g, '_')}`;
	}

	/**
     * @param {Array<any>} historyEntries - Raw history entries
     * @returns {Array<object>}
     */
	normalizePriceHistory(historyEntries) {
		if (!Array.isArray(historyEntries)) return [];

		const normalizedHistory = [];
		for (const entry of historyEntries) {
			if (!entry) continue;
			const timestamp = Number(entry.ts);
			const price = this.parsePriceValue(entry.price);
			if (!Number.isFinite(timestamp) || timestamp <= 0 || price === null) continue;
			normalizedHistory.push({ts: timestamp, price: price});
		}
		normalizedHistory.sort((a, b) => a.ts - b.ts);

		const deduplicatedHistory = [];
		for (const entry of normalizedHistory) {
			const previousEntry = deduplicatedHistory[deduplicatedHistory.length - 1];
			if (previousEntry && previousEntry.ts === entry.ts) {
				previousEntry.price = entry.price;
			} else if (previousEntry && previousEntry.price === entry.price) {
				continue;
			} else {
				deduplicatedHistory.push(entry);
			}
		}
		return deduplicatedHistory;
	}

	/**
     * @param {string} priceDefinition - Price definition category
     */
	async ensurePriceHistoryState(priceDefinition) {
		const stateName = this.getPriceHistoryStateName(priceDefinition);
		await this.extendObjectAsync(stateName, {
			type: 'state',
			common: {
				name: `Price history ${priceDefinition}`,
				type: 'string',
				role: 'json',
				read: true,
				write: false,
				def: '[]',
			},
			native: {
				priceDefinition: priceDefinition
			},
		});
	}

	/**
     * @param {string} priceDefinition - Price definition category
     * @returns {Promise<Array<object>>}
     */
	async loadPriceHistory(priceDefinition) {
		if (this.priceHistories[priceDefinition]) return this.priceHistories[priceDefinition];

		await this.ensurePriceHistoryState(priceDefinition);
		const stateName = this.getPriceHistoryStateName(priceDefinition);
		const historyState = await this.getStateAsync(stateName);
		let historyEntries = [];
		if (historyState && historyState.val) {
			try {
				historyEntries = JSON.parse(historyState.val.toString());
			} catch (error) {
				this.log.warn(`[loadPriceHistory] Cannot parse dynamic price history for ${priceDefinition}: ${error.message}`);
			}
		}
		this.priceHistories[priceDefinition] = this.normalizePriceHistory(historyEntries);
		return this.priceHistories[priceDefinition];
	}

	/**
     * @param {string} priceDefinition - Price definition category
     */
	async persistPriceHistory(priceDefinition) {
		await this.ensurePriceHistoryState(priceDefinition);
		const stateName = this.getPriceHistoryStateName(priceDefinition);
		await this.setStateAsync(stateName, {
			val: JSON.stringify(this.priceHistories[priceDefinition] || []),
			ack: true
		});
	}

	/**
     * @param {string} priceDefinition - Price definition category
     * @param {any} price - Dynamic unit price
     * @param {any} timestamp - Timestamp from price state
     * @returns {Promise<boolean>}
     */
	async storeDynamicPriceHistory(priceDefinition, price, timestamp) {
		const priceNumber = this.parsePriceValue(price);
		if (priceNumber === null) {
			this.log.warn(`[storeDynamicPriceHistory] Cannot store dynamic price ${JSON.stringify(price)} for ${priceDefinition}, value is not numeric`);
			return false;
		}

		const history = await this.loadPriceHistory(priceDefinition);
		const priceTimestamp = this.getTimestampOrNow(timestamp);
		const existingEntry = history.find(entry => entry.ts === priceTimestamp);
		if (existingEntry) {
			if (existingEntry.price === priceNumber) return false;
			existingEntry.price = priceNumber;
			this.priceHistories[priceDefinition] = this.normalizePriceHistory(history);
			await this.persistPriceHistory(priceDefinition);
			return true;
		}

		const previousEntry = history.reduce((previous, entry) => {
			if (entry.ts <= priceTimestamp && (!previous || entry.ts > previous.ts)) return entry;
			return previous;
		}, null);
		if (previousEntry && previousEntry.price === priceNumber) return false;

		history.push({ts: priceTimestamp, price: priceNumber});
		this.priceHistories[priceDefinition] = this.normalizePriceHistory(history);
		await this.persistPriceHistory(priceDefinition);
		this.log.info(`Stored dynamic price ${priceNumber} for ${priceDefinition} at ${new Date(priceTimestamp).toISOString()}`);
		return true;
	}

	/**
     * @param {string} priceDefinition - Price definition category
     * @param {number} timestamp - Consumption timestamp
     * @param {any} fallbackPrice - Fallback unit price
     * @returns {Promise<number | null>}
     */
	async getDynamicPriceForTimestamp(priceDefinition, timestamp, fallbackPrice) {
		const priceTimestamp = this.getTimestampOrNow(timestamp);
		const history = await this.loadPriceHistory(priceDefinition);
		let selectedEntry = null;
		for (const entry of history) {
			if (entry.ts <= priceTimestamp) {
				selectedEntry = entry;
			} else {
				break;
			}
		}
		if (selectedEntry) return selectedEntry.price;

		const fallbackPriceNumber = this.parsePriceValue(fallbackPrice);
		if (fallbackPriceNumber !== null) return fallbackPriceNumber;
		return history.length > 0 ? history[0].price : null;
	}

	/**
     * Split a cumulative meter delta over all dynamic price intervals between two readings.
     * @param {string} priceDefinition - Price definition category
     * @param {number} delta - Consumption delta
     * @param {any} startTimestamp - Previous reading timestamp
     * @param {any} endTimestamp - Current reading timestamp
     * @param {any} fallbackPrice - Fallback unit price
     * @returns {Promise<number | null>}
     */
	async calculateDynamicPriceDelta(priceDefinition, delta, startTimestamp, endTimestamp, fallbackPrice) {
		const startTs = Number(startTimestamp);
		const endTs = this.getTimestampOrNow(endTimestamp);
		if (!Number.isFinite(startTs) || startTs <= 0 || startTs >= endTs) {
			const priceAtReading = await this.getDynamicPriceForTimestamp(priceDefinition, endTs, fallbackPrice);
			return priceAtReading === null ? null : delta * priceAtReading;
		}

		const history = await this.loadPriceHistory(priceDefinition);
		const intervalChanges = history.filter(entry => entry.ts > startTs && entry.ts < endTs);
		if (intervalChanges.length === 0) {
			const priceAtReading = await this.getDynamicPriceForTimestamp(priceDefinition, endTs, fallbackPrice);
			return priceAtReading === null ? null : delta * priceAtReading;
		}

		const totalDuration = endTs - startTs;
		let segmentStart = startTs;
		let priceDelta = 0;

		for (const change of intervalChanges) {
			const segmentPrice = await this.getDynamicPriceForTimestamp(priceDefinition, segmentStart, fallbackPrice);
			if (segmentPrice === null) return null;
			priceDelta += delta * ((change.ts - segmentStart) / totalDuration) * segmentPrice;
			segmentStart = change.ts;
		}

		const finalSegmentPrice = await this.getDynamicPriceForTimestamp(priceDefinition, segmentStart, fallbackPrice);
		if (finalSegmentPrice === null) return null;
		priceDelta += delta * ((endTs - segmentStart) / totalDuration) * finalSegmentPrice;
		return priceDelta;
	}

	/**
     * @param {number} reading - Current cumulative reading
     * @param {object} calcValues - Stored period start values
     * @param {number} unitPrice - Unit price for fallback calculation
     * @returns {object}
     */
	getFallbackDynamicCostTotals(reading, calcValues, unitPrice) {
		return {
			priceDay: unitPrice * (reading - this.getNumberOrDefault(calcValues.start_day, reading)),
			priceWeek: unitPrice * (reading - this.getNumberOrDefault(calcValues.start_week, reading)),
			priceMonth: unitPrice * (reading - this.getNumberOrDefault(calcValues.start_month, reading)),
			priceQuarter: unitPrice * (reading - this.getNumberOrDefault(calcValues.start_quarter, reading)),
			priceYear: unitPrice * (reading - this.getNumberOrDefault(calcValues.start_year, reading)),
		};
	}

	/**
     * @param {string} stateID - Local ioBroker state ID
     * @param {number} fallback - Fallback value
     * @returns {Promise<number>}
     */
	async readCostStateOrFallback(stateID, fallback) {
		try {
			const state = await this.getStateAsync(stateID);
			const stateValue = state ? this.parsePriceValue(state.val) : null;
			return stateValue === null ? fallback : stateValue;
		} catch (error) {
			this.log.debug(`[readCostStateOrFallback] Could not read ${stateID}, using fallback ${fallback}: ${error.message}`);
			return fallback;
		}
	}

	/**
     * @param {object} dynamicCosts - Dynamic cost memory
     * @returns {Promise<object>}
     */
	async roundDynamicCostTotals(dynamicCosts) {
		return {
			priceDay: await this.roundCosts(this.getNumberOrDefault(dynamicCosts.totals.priceDay, 0)),
			priceWeek: await this.roundCosts(this.getNumberOrDefault(dynamicCosts.totals.priceWeek, 0)),
			priceMonth: await this.roundCosts(this.getNumberOrDefault(dynamicCosts.totals.priceMonth, 0)),
			priceQuarter: await this.roundCosts(this.getNumberOrDefault(dynamicCosts.totals.priceQuarter, 0)),
			priceYear: await this.roundCosts(this.getNumberOrDefault(dynamicCosts.totals.priceYear, 0)),
		};
	}

	/**
     * Initialise dynamic cost memory from existing states, so restarts do not revalue past consumption.
     * @param {string} stateID - Source state ID
     * @param {number} reading - Current cumulative reading
     * @param {any} timestamp - Timestamp of the current reading
     * @returns {Promise<object | null>}
     */
	async ensureDynamicCostMemory(stateID, reading, timestamp) {
		if (!this.isDynamicPriceState(stateID)) return null;
		if (!this.activeStates[stateID] || !this.activeStates[stateID].stateDetails || !this.activeStates[stateID].calcValues) return null;

		const readingNumber = this.parsePriceValue(reading);
		const readingTimestamp = this.getTimestampOrNow(timestamp);
		if (readingNumber === null) {
			this.log.warn(`[ensureDynamicCostMemory] Cannot initialize dynamic costs for ${stateID}, reading ${JSON.stringify(reading)} is not numeric`);
			return null;
		}

		const activeState = this.activeStates[stateID];
		if (activeState.dynamicCosts && activeState.dynamicCosts.totals) {
			if (activeState.dynamicCosts.lastReading === null || activeState.dynamicCosts.lastReading === undefined) {
				activeState.dynamicCosts.lastReading = readingNumber;
			}
			if (activeState.dynamicCosts.lastTs === null || activeState.dynamicCosts.lastTs === undefined) {
				activeState.dynamicCosts.lastTs = readingTimestamp;
			}
			return activeState.dynamicCosts;
		}

		const unitPrice = this.getNumberOrDefault(activeState.prices.unitPrice, 0);
		const fallbackTotals = this.getFallbackDynamicCostTotals(readingNumber, activeState.calcValues, unitPrice);
		const stateRoot = `${activeState.stateDetails.deviceName}.currentYear.${activeState.stateDetails.financialCategory}`;
		const totals = {
			priceDay: await this.readCostStateOrFallback(`${stateRoot}.01_currentDay`, fallbackTotals.priceDay),
			priceWeek: await this.readCostStateOrFallback(`${stateRoot}.02_currentWeek`, fallbackTotals.priceWeek),
			priceMonth: await this.readCostStateOrFallback(`${stateRoot}.03_currentMonth`, fallbackTotals.priceMonth),
			priceQuarter: await this.readCostStateOrFallback(`${stateRoot}.04_currentQuarter`, fallbackTotals.priceQuarter),
			priceYear: await this.readCostStateOrFallback(`${stateRoot}.05_currentYear`, fallbackTotals.priceYear),
		};

		activeState.dynamicCosts = {
			lastReading: readingNumber,
			lastTs: readingTimestamp,
			totals: totals
		};
		this.log.debug(`[ensureDynamicCostMemory] Initialized dynamic costs for ${stateID}: ${JSON.stringify(activeState.dynamicCosts)}`);
		return activeState.dynamicCosts;
	}

	/**
     * Add the newly consumed delta to dynamic cost totals with the active unit price.
     * @param {string} stateID - Source state ID
     * @param {number} reading - Current cumulative reading
     * @param {any} timestamp - Timestamp of the current reading
     * @returns {Promise<object | null>}
     */
	async calculateDynamicCostsForState(stateID, reading, timestamp) {
		const dynamicCosts = await this.ensureDynamicCostMemory(stateID, reading, timestamp);
		if (!dynamicCosts) return null;

		const readingNumber = this.parsePriceValue(reading);
		const activeState = this.activeStates[stateID];
		const readingTimestamp = this.getTimestampOrNow(timestamp);
		if (readingNumber === null) {
			this.log.warn(`[calculateDynamicCostsForState] Cannot calculate dynamic costs for ${stateID}, reading ${JSON.stringify(reading)} is not numeric`);
			return this.roundDynamicCostTotals(dynamicCosts);
		}

		const lastReading = this.parsePriceValue(dynamicCosts.lastReading);
		if (lastReading === null) {
			dynamicCosts.lastReading = readingNumber;
			dynamicCosts.lastTs = readingTimestamp;
			return this.roundDynamicCostTotals(dynamicCosts);
		}

		const delta = readingNumber - lastReading;
		if (delta < 0) {
			this.log.warn(`[calculateDynamicCostsForState] Cumulative reading for ${stateID} decreased from ${lastReading} to ${readingNumber}, resetting dynamic cost tracker`);
			dynamicCosts.lastReading = readingNumber;
			dynamicCosts.lastTs = readingTimestamp;
			return this.roundDynamicCostTotals(dynamicCosts);
		}

		if (delta > 0) {
			const priceDelta = await this.calculateDynamicPriceDelta(activeState.stateDetails.stateType, delta, dynamicCosts.lastTs, readingTimestamp, activeState.prices.unitPrice);
			if (priceDelta === null) {
				this.log.warn(`[calculateDynamicCostsForState] Cannot calculate dynamic costs for ${stateID}, no valid price found for ${new Date(readingTimestamp).toISOString()}`);
				return this.roundDynamicCostTotals(dynamicCosts);
			}
			dynamicCosts.totals.priceDay = this.getNumberOrDefault(dynamicCosts.totals.priceDay, 0) + priceDelta;
			dynamicCosts.totals.priceWeek = this.getNumberOrDefault(dynamicCosts.totals.priceWeek, 0) + priceDelta;
			dynamicCosts.totals.priceMonth = this.getNumberOrDefault(dynamicCosts.totals.priceMonth, 0) + priceDelta;
			dynamicCosts.totals.priceQuarter = this.getNumberOrDefault(dynamicCosts.totals.priceQuarter, 0) + priceDelta;
			dynamicCosts.totals.priceYear = this.getNumberOrDefault(dynamicCosts.totals.priceYear, 0) + priceDelta;
			dynamicCosts.lastReading = readingNumber;
			dynamicCosts.lastTs = readingTimestamp;
			this.log.debug(`[calculateDynamicCostsForState] Added dynamic cost delta ${priceDelta} for ${delta} consumption from ${stateID} at ${new Date(readingTimestamp).toISOString()}`);
		} else if (readingTimestamp > this.getNumberOrDefault(dynamicCosts.lastTs, 0)) {
			dynamicCosts.lastTs = readingTimestamp;
		}

		return this.roundDynamicCostTotals(dynamicCosts);
	}

	/**
     * Reset dynamic cost totals when period start values are reset.
     * @param {string} stateID - Source state ID
     * @param {number} reading - Current cumulative reading
     * @param {object} beforeReset - Date information before reset
     */
	resetDynamicCostMemory(stateID, reading, beforeReset) {
		if (!this.isDynamicPriceState(stateID)) return;

		const activeState = this.activeStates[stateID];
		const readingNumber = this.parsePriceValue(reading);
		if (!activeState || readingNumber === null) return;

		const existingTotals = activeState.dynamicCosts && activeState.dynamicCosts.totals ? activeState.dynamicCosts.totals : {};
		activeState.dynamicCosts = {
			lastReading: readingNumber,
			lastTs: Date.now(),
			totals: {
				priceDay: 0,
				priceWeek: beforeReset.week === actualDate.week ? this.getNumberOrDefault(existingTotals.priceWeek, 0) : 0,
				priceMonth: beforeReset.month === actualDate.month ? this.getNumberOrDefault(existingTotals.priceMonth, 0) : 0,
				priceQuarter: beforeReset.quarter === actualDate.quarter ? this.getNumberOrDefault(existingTotals.priceQuarter, 0) : 0,
				priceYear: beforeReset.year === actualDate.year ? this.getNumberOrDefault(existingTotals.priceYear, 0) : 0,
			}
		};
		this.log.debug(`[resetDynamicCostMemory] Reset dynamic costs for ${stateID}: ${JSON.stringify(activeState.dynamicCosts)}`);
	}

	/**
     * Write financial calculation states.
     * @param {string} stateID - Source state ID
     * @param {object} calculationRounded - Rounded calculation values
     * @param {Date} date - Current date
     */
	async writeFinancialStates(stateID, calculationRounded, date) {
		if (!this.activeStates[stateID] || !this.activeStates[stateID].stateDetails) return;

		const stateDetails = this.activeStates[stateID].stateDetails;
		let stateName = `${this.namespace}.${stateDetails.deviceName}.currentYear.${stateDetails.financialCategory}`;
		await this.setStateChangedAsync(`${stateName}.01_currentDay`, {
			val: calculationRounded.priceDay,
			ack: true
		});
		await this.setStateChangedAsync(`${stateName}.02_currentWeek`, {
			val: calculationRounded.priceWeek,
			ack: true
		});
		await this.setStateChangedAsync(`${stateName}.03_currentMonth`, {
			val: calculationRounded.priceMonth,
			ack: true
		});
		await this.setStateChangedAsync(`${stateName}.04_currentQuarter`, {
			val: calculationRounded.priceQuarter,
			ack: true
		});
		await this.setStateChangedAsync(`${stateName}.05_currentYear`, {
			val: calculationRounded.priceYear,
			ack: true
		});

		if (this.config.store_weeks || this.config.store_months || this.config.store_quarters) {
			await this.setStateChangedAsync(`${this.namespace}.${stateDetails.deviceName}.${actualDate.year}.${stateDetails.financialCategory}Cumulative`, {
				val: calculationRounded.priceYear,
				ack: true
			});
		}

		await this.setStateChangedAsync(`${stateName}.currentWeek.${weekdays[date.getDay()]}`, {
			val: calculationRounded.priceDay,
			ack: true
		});

		stateName = `${this.namespace}.${stateDetails.deviceName}.${actualDate.year}.${stateDetails.financialCategory}`;
		if (storeSettings.storeWeeks) await this.setStateChangedAsync(`${stateName}.weeks.${actualDate.week}`, {
			val: calculationRounded.priceWeek,
			ack: true
		});
		if (storeSettings.storeMonths) await this.setStateChangedAsync(`${stateName}.months.${actualDate.month}`, {
			val: calculationRounded.priceMonth,
			ack: true
		});
		if (storeSettings.storeQuarters) await this.setStateChangedAsync(`${stateName}.quarters.Q${actualDate.quarter}`, {
			val: calculationRounded.priceQuarter,
			ack: true
		});
	}

	//ToDo 0.5: Implement cleanup for unused states
	// async cleanupUnused() {
	//     const allStates = await this.getAdapterObjectsAsync()
	//     this.log.info((JSON.stringify(allStates)))
	// }

	/**
     * Load calculation factors from helper library and store to memory
     */
	async definitionLoader() {
		try {
			// Load energy array and store exponents related to unit
			let catArray = ['Watt', 'Watt_hour'];
			const unitStore = this.unitPriceDef.unitConfig;
			for (const item in catArray) {
				const unitItem = adapterHelpers.units.electricity[catArray[item]];
				for (const unitCat in unitItem) {
					unitStore[unitItem[unitCat].unit] = {
						exponent: unitItem[unitCat].exponent,
						category: catArray[item],
					};
				}
			}

			// Load  volumes array and store exponents related to unit
			catArray = ['Liter', 'Cubic_meter'];
			for (const item in catArray) {
				const unitItem = adapterHelpers.units.volume[catArray[item]];
				for (const unitCat in unitItem) {
					unitStore[unitItem[unitCat].unit] = {
						exponent: unitItem[unitCat].exponent,
						category: catArray[item],
					};
				}
			}

			// Load price definition from admin configuration
			const pricesConfig = this.config.pricesDefinition || [];
			const priceStore = this.unitPriceDef.pricesConfig;
			this.dynamicPriceStates = {};

			for (const priceDef in pricesConfig) {
				const priceConfig = pricesConfig[priceDef];
				const priceSource = priceConfig.priceSource === 'state' ? 'state' : 'static';
				const priceState = priceSource === 'state' && typeof priceConfig.priceState === 'string' ? priceConfig.priceState.trim() : '';
				const configuredUnitPrice = this.parsePriceValue(priceConfig.uPpU);
				const configuredBasicPrice = this.parsePriceValue(priceConfig.uPpM);
				let unitPrice = configuredUnitPrice;

				if (priceSource === 'state') {
					await this.ensurePriceHistoryState(priceConfig.cat);
					if (priceState) {
						if (!this.dynamicPriceStates[priceState]) {
							this.dynamicPriceStates[priceState] = [];
						}
						this.dynamicPriceStates[priceState].push(priceConfig.cat);
						this.subscribeForeignStates(priceState);

						const priceStateValue = await this.getForeignStateAsync(priceState);
						const dynamicUnitPrice = priceStateValue ? this.parsePriceValue(priceStateValue.val) : null;
						if (dynamicUnitPrice !== null) {
							unitPrice = dynamicUnitPrice;
							await this.storeDynamicPriceHistory(priceConfig.cat, dynamicUnitPrice, this.getStateChangeTimestamp(priceStateValue));
							this.log.info(`Loaded dynamic unit price ${unitPrice} for ${priceConfig.cat} from ${priceState}`);
						} else {
							this.log.warn(`Dynamic price state ${priceState} for ${priceConfig.cat} has no valid numeric value, using configured fallback price ${priceConfig.uPpU}`);
						}
					} else {
						this.log.warn(`Price definition ${priceConfig.cat} uses dynamic price source but no state ID is configured, using configured fallback price ${priceConfig.uPpU}`);
					}
				}

				if (unitPrice === null) {
					this.log.warn(`Price definition ${priceConfig.cat} has no valid unit price ${JSON.stringify(priceConfig.uPpU)}, using 0 to avoid invalid cost calculations`);
					unitPrice = 0;
				}

				priceStore[priceConfig.cat] = {
					cat: priceConfig.cat,
					uDes: priceConfig.cat,
					uPpU: unitPrice,
					uPpM: configuredBasicPrice === null ? priceConfig.uPpM : configuredBasicPrice,
					costType: priceConfig.costType,
					unitType: priceConfig.unitType,
					priceSource: priceSource,
					priceState: priceState,
				};
			}

			console.debug(`All Unit category's ${JSON.stringify(this.unitPriceDef)}`);

		} catch (error) {
			this.errorHandling('[definitionLoader]', error);
		}

	}

	/**
	 * Load state definitions to memory this.activeStates[stateID]
	 * @param {string} stateID ID  of state to refresh memory values
	 */
	async buildStateDetailsArray(stateID) {
		let initError  = false;
		this.log.debug(`[buildStateDetailsArray] started for ${stateID}`);
		try {

			let stateInfo;
			try {
				// Load configuration as provided in object
				stateInfo = await this.getForeignObjectAsync(stateID);
				if (!stateInfo) {
					this.log.error(`Can't get information for ${stateID}, state will be ignored`);
					delete this.activeStates[stateID];
					this.unsubscribeForeignStates(stateID);
					initError = true;
					return false;
				}
			} catch (error) {
				this.log.error(`${stateID} is incorrectly correctly formatted, ${JSON.stringify(error)}`);
				delete this.activeStates[stateID];
				this.unsubscribeForeignStates(stateID);
				initError = true;
				return false;
			}

			// Replace not allowed characters for state name
			const newDeviceName = stateID.split('.').join('__');

			// Check if configuration for SourceAnalytix is present, trow error in case of issue in configuration
			if (stateInfo && stateInfo.common && stateInfo.common.custom && stateInfo.common.custom[this.namespace]) {
				const customData = stateInfo.common.custom[this.namespace];
				const commonData = stateInfo.common;
				this.log.debug(`[buildStateDetailsArray] commonData ${JSON.stringify(commonData)}`);

				// Load start value from config to memory (avoid wrong calculations at meter reset, set to 0 if empty)
				const valueAtDeviceReset = (customData.valueAtDeviceReset || customData.valueAtDeviceReset === 0) ? customData.valueAtDeviceReset : null;

				// Always set init value to null at first start, will take init value at first calculation from state
				const valueAtDeviceInit = null;

				// Read current known total value to memory (if present)
				let cumulativeValue = await this.getCumulatedValue(stateID, newDeviceName);
				cumulativeValue = cumulativeValue ? cumulativeValue : 0;
				this.log.debug(`[buildStateDetailsArray] cumulativeValue ${JSON.stringify(cumulativeValue)} | valueAtDeviceReset ${JSON.stringify(valueAtDeviceReset)} | valueAtDeviceInit ${JSON.stringify(valueAtDeviceInit)}`);

				// Check and load unit definition
				let useUnit = '';
				// Check if a unit is manually selected, if yes use that one
				if (this.unitPriceDef.unitConfig[customData.selectedUnit]) {
					useUnit = customData.selectedUnit;
					this.log.debug(`[buildStateDetailsArray] unit manually chosen ${JSON.stringify(useUnit)}`);

				// If not, try to automatically get unit from state object
				} else if (commonData.unit && commonData.unit !== '' && this.unitPriceDef.unitConfig[commonData.unit]) {

					useUnit = commonData.unit;
					this.log.debug(`[buildStateDetailsArray] unit automatically detected ${JSON.stringify(useUnit)}`);
				} else {
					this.log.error(`No unit defined for ${stateID}, cannot execute calculations !`);
					this.log.error(`Please choose unit manually in state configuration`);
					initError = true;
				}

				// Load state price definition
				if (!customData.selectedPrice || customData.selectedPrice === '' || customData.selectedPrice === 'Choose') {
					this.log.error(`No cost type defined for ${stateID}, please Select Type of calculation at state setting`);
					initError = true;
				} else if (!this.unitPriceDef.pricesConfig[customData.selectedPrice]) {
					this.log.error(`Selected Type ${customData.selectedPrice} does not exist in Price Definitions`);
					this.log.error(`Please choose proper type for state ${stateID}`);
					this.log.error(`Or add price definition ${customData.selectedPrice} in adapter settings`);
					initError = true;
				}

				if (valueAtDeviceReset > cumulativeValue){
					// Ignore issue if categories = Watt, init value not used
					if (useUnit !== 'W') {
						this.log.error(`Check settings for ${stateID} ! Known valueAtDeviceReset : (${valueAtDeviceReset}) > known cumulative value (${cumulativeValue}) cannot proceed`);
						this.log.error(`Troubleshoot Data ${stateID} custom Data : ${JSON.stringify(stateInfo)} `);
						initError = true;
					}
				}

				// In case of one of above checks fails, abort procedure
				if (initError){
					this.log.error(`Cannot handle calculations for ${stateID}, check log messages and adjust settings!`);
					delete this.activeStates[stateID];
					this.unsubscribeForeignStates(stateID);
					return false;
				}

				// Load price definition from settings & library
				const selectedPriceConfig = this.unitPriceDef.pricesConfig[customData.selectedPrice];
				const stateType = selectedPriceConfig.costType;

				// Load state settings to memory
				this.activeStates[stateID] = {
					stateDetails: {
						alias: customData.alias !== '' ? customData.alias : '',
						consumption: customData.consumption,
						costs: customData.costs,
						deviceName: newDeviceName.toString(),
						financialCategory: stateType,
						headCategory: stateType === 'earnings' ? 'delivered' : 'consumed',
						meter_values: customData.meter_values,
						name: stateInfo.common.name !== '' ? customData.alias : 'No name known, please provide alias',
						stateType: customData.selectedPrice,
						stateUnit: useUnit,
						useUnit: selectedPriceConfig.unitType,
						deviceResetLogicEnabled: customData.deviceResetLogicEnabled != null ? customData.deviceResetLogicEnabled || true : true,
						threshold: customData.threshold != null ? customData.threshold || 1 : 1,
					},
					calcValues: {
						cumulativeValue: cumulativeValue,
						start_day: customData.start_day,
						start_month: customData.start_month,
						start_quarter: customData.start_quarter,
						start_week: customData.start_week,
						start_year: customData.start_year,
						valueAtDeviceReset: valueAtDeviceReset,
						valueAtDeviceInit: valueAtDeviceInit,
					},
					prices: {
						basicPrice: selectedPriceConfig.uPpM,
						unitPrice: selectedPriceConfig.uPpU,
						priceSource: selectedPriceConfig.priceSource,
						priceState: selectedPriceConfig.priceState,
					},
				};

				// Extend memory with objects for watt to kWh calculation
				if (useUnit === 'W') {
					this.activeStates[stateID].calcValues.previousReadingWatt = null;
					this.activeStates[stateID].calcValues.previousReadingWattTs = null;
				}
				this.log.debug(`[buildStateDetailsArray] completed for ${stateID}: with content ${JSON.stringify(this.activeStates[stateID])}`);
				return true;
			}
		} catch (error) {
			this.errorHandling(`[buildStateDetailsArray] ${stateID}`, error);
			return false;
		}
	}

	// Create object tree and states for all devices to be handled
	async initialize(stateID) {
		try {

			this.log.debug(`Initialising ${stateID} with configuration ${JSON.stringify(this.activeStates[stateID])}`);

			// Shorten configuration details for easier access
			if (!this.activeStates[stateID] || !this.activeStates[stateID].stateDetails) {
				this.log.error(`Cannot handle initialisation for ${stateID}`);
				return;
			}

			const stateDetails = this.activeStates[stateID].stateDetails;

			this.log.debug(`Defined calculation attributes for ${stateID} : ${JSON.stringify(this.activeStates[stateID])}`);
			// Check if alias is used and update object with new naming (if changed)
			let alias = stateDetails.name;
			if (stateDetails.alias && stateDetails.alias !== '') {
				alias = stateDetails.alias;
			}

			this.log.debug('Name after alias renaming' + alias);

			// Create Device Object
			await this.extendObjectAsync(stateDetails.deviceName, {
				type: 'device',
				common: {
					name: alias
				},
				native: {},
			});

			// create states for day value storage
			for (const x in weekdays) {

				if (this.config.currentYearDays === true) {
					await this.doLocalStateCreate(stateID, `currentWeek.${weekdays[x]}`, weekdays[x], false, false, true);
				} else if (stateDeletion) {
					this.log.debug(`Deleting states for week ${weekdays[x]} (if present)`);
					await this.doLocalStateCreate(stateID, `currentWeek.${weekdays[x]}`, weekdays[x], false, true, true);
				}

				if (this.config.currentYearPrevious === true) {
					await this.doLocalStateCreate(stateID, `previousWeek.${weekdays[x]}`, weekdays[x], false, false, true);
				} else if (stateDeletion) {
					this.log.debug(`Deleting states for week ${weekdays[x]} (if present)`);
					await this.doLocalStateCreate(stateID, `previousWeek.${weekdays[x]}`, weekdays[x], false, true, true);

				}
			}

			// create states for weeks
			for (let y = 1; y < 54; y++) {
				let weekNr;
				if (y < 10) {
					weekNr = '0' + y;
				} else {
					weekNr = y.toString();
				}
				const weekRoot = `weeks.${weekNr}`;

				if (this.config.store_weeks) {
					this.log.debug(`Creating states for week ${weekNr}`);
					await this.doLocalStateCreate(stateID, weekRoot, weekNr);
				} else if (stateDeletion) {
					this.log.debug(`Deleting states for week ${weekNr} (if present)`);
					await this.doLocalStateCreate(stateID, weekRoot, weekNr, false, true);
				}
			}

			// create states for months
			for (const month in months) {
				const monthRoot = `months.${months[month]}`;

				if (this.config.store_months) {
					this.log.debug(`Creating states for month ${month}`);
					await this.doLocalStateCreate(stateID, monthRoot, months[month]);
				} else if (stateDeletion) {
					this.log.debug(`Deleting states for month ${month} (if present)`);
					await this.doLocalStateCreate(stateID, monthRoot, months[month], false, true);
				}
			}
			// create states for quarters
			for (let y = 1; y < 5; y++) {
				const quarterRoot = `quarters.Q${y}`;
				if (this.config.store_quarters) {
					this.log.debug(`Creating states for quarter ${quarterRoot}`);
					await this.doLocalStateCreate(stateID, quarterRoot, `Q${y}`);
				} else if (stateDeletion) {
					this.log.debug(`Deleting states for quarter ${quarterRoot} (if present)`);
					await this.doLocalStateCreate(stateID, quarterRoot, quarterRoot, false, true);
				}
			}

			// Create basic current states
			for (const state of basicStates) {
				await this.doLocalStateCreate(stateID, state, state, false, false, true);
				// .${actualDate.year}.

				//ToDo 0.4.9: Check if current year storage in Year root should be configurable
				if (state === '05_currentYear' &&  ((stateDetails.consumption || stateDetails.costs)
					&& (this.config.store_quarters || this.config.store_months || this.config.store_weeks ))){
					await this.doLocalStateCreate(stateID, `${actualDate.year}.${stateDetails.headCategory}Cumulative`, `${stateDetails.headCategory}Cumulative`, true, false, false);
					await this.doLocalStateCreate(stateID, `${actualDate.year}.${stateDetails.financialCategory}Cumulative`, `${stateDetails.financialCategory}Cumulative`, true, false, false, useCurrency);

				} else if (state === '05_currentYear' &&  (!this.config.store_weeks && !this.config.store_months && !this.config.store_quarters)) {
					await this.doLocalStateCreate(stateID, `${actualDate.year}.${stateDetails.headCategory}Cumulative`, `${stateDetails.headCategory}Cumulative`, true, true, false);
					await this.doLocalStateCreate(stateID, `${actualDate.year}.${stateDetails.financialCategory}Cumulative`, `${stateDetails.financialCategory}Cumulative`, true, true, false, useCurrency);

				}
			}

			// Create basic current states for previous periods
			if (this.config.currentYearPrevious) {
				for (const state of basicPreviousStates) {
					await this.doLocalStateCreate(stateID, state, state, false, false, true);
				}
			}

			// Create state for cumulative reading
			const stateName = 'cumulativeReading';
			await this.doLocalStateCreate(stateID, stateName, 'Cumulative Reading', true);

			// Create state for cumulative reading at Year statistics
			if (this.config.store_weeks || this.config.store_months || this.config.store_quarters){
				await this.doLocalStateCreate(stateID, `${actualDate.year}.readingCumulative`, 'Cumulative Reading of Year total', true);
			}

			// Handle calculation
			const value = await this.getForeignStateAsync(stateID);
			this.log.debug(`First time calc result after initialising ${stateID}  with value ${JSON.stringify(value)}`);
			if (value) {
				// await this.buildVisWidgetJson(stateID);
				await this.calculationHandler(stateID, value);
			}

			// Subscribe state, every state change will trigger calculation now automatically
			this.subscribeForeignStates(stateID);

		} catch (error) {
			this.errorHandling(`[initialize] ${stateID}`, error);
		}
	}

	/**
     * Is called if an object changes to ensure (de-) activation of calculation or update configuration settings
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
	async onObjectChange(id, obj) {
	    //ToDo : Verify with test-results if debounce on object change must be implemented
		if (calcBlock) return; // cancel operation if calculation block is activate
		try {
			const stateID = id;

			// Check if object is activated for SourceAnalytix
			if (obj && obj.common) {

				// if (obj.from === `system.adapter.${this.namespace}`) return; // Ignore object change if cause by SourceAnalytix to prevent overwrite
				// Verify if custom information is available regarding SourceAnalytix
				if (obj.common.custom && obj.common.custom[this.namespace] && obj.common.custom[this.namespace].enabled) {

					// ignore object changes when caused by SA (memory is handled internally)
					// if (obj.from !== `system.adapter.${this.namespace}`) {
					this.log.debug(`Object array of SourceAnalytix activated state changed : ${JSON.stringify(obj)} stored config : ${JSON.stringify(this.activeStates)}`);
					// const newDeviceName = stateID.split('.').join('__');

					// Verify if the object was already activated, if not initialize new device
					if (!this.activeStates[stateID]) {
						this.log.info(`Enable SourceAnalytix for : ${stateID}`);
						await this.buildStateDetailsArray(id);
						this.log.debug(`Active state array after enabling ${stateID} : ${JSON.stringify(this.activeStates)}`);
						if (this.activeStates[stateID]){
							await this.initialize(stateID);
						} else {
							this.log.warn(`[Cannot enable SourceAnalytix for ${stateID}, check settings and error messages`);
						}
					} else {
						this.log.info(`Updating SourceAnalytix configuration for : ${stateID}`);
						await this.buildStateDetailsArray(id);
						this.log.debug(`Active state array after updating configuration of ${stateID} : ${JSON.stringify(this.activeStates)}`);
						// Only run initialisation if state is successfully created during buildStateDetailsArray
						if (this.activeStates[stateID]){
							await this.initialize(stateID);
						} else {
							this.log.warn(`[Cannot update SourceAnalytix configuration for ${stateID}, check settings and error messages`);
						}
					}

				} else if (this.activeStates[stateID]) {
					delete this.activeStates[stateID];
					this.log.info(`Disabled SourceAnalytix for : ${stateID}`);
					this.log.debug(`Active state array after deactivation of ${stateID} : ${JSON.stringify(this.activeStates)}`);
					this.unsubscribeForeignStates(stateID);
				}

			} else {
				// Object change not related to this adapter, ignoring
			}
		} catch (error) {
			// Send code failure to sentry
			this.errorHandling(`[onObjectChange] ${id}`, error);
		}
	}

	/**
     * Handle updates from dynamic price states and recalculate matching cost states.
     * @param {string} priceStateID - ioBroker state ID of the dynamic price source
     * @param {ioBroker.State} state - New price state value
     */
	async handleDynamicPriceChange(priceStateID, state) {
		try {
			const unitPrice = this.parsePriceValue(state.val);
			if (unitPrice === null) {
				this.log.warn(`Dynamic price state ${priceStateID} changed but value ${JSON.stringify(state.val)} is not numeric, keeping previous price`);
				return;
			}

			for (const priceDefinition of this.dynamicPriceStates[priceStateID]) {
				const priceConfig = this.unitPriceDef.pricesConfig[priceDefinition];
				if (!priceConfig) {
					this.log.warn(`Dynamic price update for ${priceDefinition} ignored because the price definition is not loaded`);
					continue;
				}

				const previousPrice = priceConfig.uPpU;
				await this.storeDynamicPriceHistory(priceDefinition, unitPrice, this.getStateChangeTimestamp(state));
				priceConfig.uPpU = unitPrice;
				this.log.info(`Dynamic unit price for ${priceDefinition} changed from ${previousPrice} to ${unitPrice}`);

				for (const stateID in this.activeStates) {
					const activeState = this.activeStates[stateID];
					if (activeState && activeState.stateDetails && activeState.stateDetails.stateType === priceDefinition) {
						activeState.prices.unitPrice = unitPrice;
					}
				}
			}
		} catch (error) {
			this.errorHandling(`[handleDynamicPriceChange] ${priceStateID}`, error);
		}
	}

	/**
     * Recalculate only financial states from the stored cumulative reading.
     * @param {string} stateID - Source state ID
     * @param {string} reason - Log context
     */
	async recalculateCostsForState(stateID, reason) {
		try {
			if (!this.activeStates[stateID] || !this.activeStates[stateID].stateDetails || !this.activeStates[stateID].calcValues) return;

			const calcValues = this.activeStates[stateID].calcValues;
			const stateDetails = this.activeStates[stateID].stateDetails;
			const statePrices = this.activeStates[stateID].prices;
			const reading = calcValues.cumulativeValue;

			if (!stateDetails.costs) return;
			if (this.isDynamicPriceState(stateID)) {
				this.log.debug(`[recalculateCostsForState] Skipped dynamic cost recalculation for ${stateID} because dynamic prices are historical`);
				return;
			}
			if (reading === null || reading === undefined) {
				this.log.warn(`[recalculateCostsForState] Cannot recalculate costs for ${stateID}, cumulative reading is not available`);
				return;
			}

			const unitPrice = this.parsePriceValue(statePrices.unitPrice);
			if (unitPrice === null) {
				this.log.warn(`[recalculateCostsForState] Cannot recalculate costs for ${stateID}, unit price ${JSON.stringify(statePrices.unitPrice)} is not numeric`);
				return;
			}

			const date = new Date();
			const calculationRounded = {
				priceDay: await this.roundCosts(unitPrice * (reading - calcValues.start_day)),
				priceWeek: await this.roundCosts(unitPrice * (reading - calcValues.start_week)),
				priceMonth: await this.roundCosts(unitPrice * (reading - calcValues.start_month)),
				priceQuarter: await this.roundCosts(unitPrice * (reading - calcValues.start_quarter)),
				priceYear: await this.roundCosts(unitPrice * (reading - calcValues.start_year)),
			};

			await this.writeFinancialStates(stateID, calculationRounded, date);

			previousCalculationRounded[stateID] = {
				...previousCalculationRounded[stateID],
				...calculationRounded
			};

			this.log.debug(`[recalculateCostsForState] Costs recalculated for ${stateID} because of ${reason}: ${JSON.stringify(calculationRounded)}`);
		} catch (error) {
			this.errorHandling(`[recalculateCostsForState] ${stateID}`, error);
		}
	}

	/**
     * Is called if a subscribed state changes
     * @param {string} id of state
     * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		if (calcBlock) return; // cancel operation if global calculation block is activate
		try {
			// Check if a valid state change has been received
			if (state) {
				// The state was changed
				this.log.debug(`state ${id} changed : ${JSON.stringify(state)} SourceAnalytix calculation executed`);

				//ToDo: Implement x ignore time (configurable) to avoid overload of unneeded calculations
				// Avoid unneeded calculation if value is equal to known value in memory
				// 10-01-2021 : disable IF check for new value to analyse if this solves 0 watt calc bug
				// 11-01-2021 : removing if successfully result, but need to check debounce !

				const isDynamicPriceState = !!this.dynamicPriceStates[id];
				if (isDynamicPriceState) {
					await this.handleDynamicPriceChange(id, state);
				}

				// Handle calculation for state
				// Check if for some reason calculation handler ist called for an object not initialised
				if (this.activeStates[id]){
					await this.calculationHandler(id, state);
				} else if (!isDynamicPriceState) {
					this.log.debug(`[onStateChange] state not initialised, calculation cancelled]`);
				}

				// } else {
				//     this.log.debug(`Update of state ${id} received with equal value ${state.val} ignoring`);
				// }

			}
		} catch (error) {
			this.errorHandling(`[onStateChange] for ${id}`, error);
		}
	}

	/**
     * Daily logic to store start values in memory and previous values at states
     */
	async resetStartValues() {
		try {
			const resetDay = new schedule('0 0 * * *', async () => {
				// const resetDay = new schedule('* * * * *', async () => { //  testing schedule
				calcBlock = true; // Pause all calculations
				const beforeReset = await this.refreshDates(); // Reset date values in memory
				this.log.debug(`[resetStartValues] Dates current : ${JSON.stringify(actualDate)} | beforeReset ${JSON.stringify(this.activeStates[beforeReset])}`);
				// Read state array and write Data for every active state
				for (const stateID in this.activeStates) {
					this.log.info(`Reset start values for : ${stateID}`);
					this.log.info(`Memory values before reset : ${JSON.stringify(this.activeStates[stateID])}`);
					try {

						if (this.activeStates[stateID] == null || this.activeStates[stateID].calcValues == null || this.activeStates[stateID].stateDetails == null)  {
							this.log.error(`Cannot handle Day reset for ${stateID}, check your configuration (error  messages  at adapter start)`);
							continue;
						}

						const stateValues = this.activeStates[stateID].calcValues;
						const stateDetails = this.activeStates[stateID].stateDetails;
						// get current meter value
						const reading = this.activeStates[stateID].calcValues.cumulativeValue;
						if (reading === null || reading === undefined) continue;

						this.log.debug(`Memory values for ${stateID} before reset : ${JSON.stringify(this.activeStates[stateID])}`);
						this.log.debug(`Current known state values : ${JSON.stringify(stateValues)}`);

						// Prepare custom object and store correct values
						const obj = {};
						obj.common = {};
						obj.common.custom = {};
						obj.common.custom[this.namespace] = {
							start_day: reading,
							start_month: beforeReset.month === actualDate.month ? stateValues.start_month : reading,
							start_quarter: beforeReset.quarter === actualDate.quarter ? stateValues.start_quarter : reading,
							start_week: beforeReset.week === actualDate.week ? stateValues.start_week : reading,
							start_year: beforeReset.year === actualDate.year ? stateValues.start_year : reading,
							valueAtDeviceInit: this.activeStates[stateID].calcValues.valueAtDeviceInit,
							valueAtDeviceReset: this.activeStates[stateID].calcValues.valueAtDeviceReset,
						};

						// Extend memory with objects for watt to kWh calculation
						if (stateDetails.stateUnit === 'W') {
							this.activeStates[stateID].calcValues.previousReadingWatt = null;
							this.activeStates[stateID].calcValues.previousReadingWattTs = null;
						}

						this.activeStates[stateID].calcValues = obj.common.custom[this.namespace];
						this.activeStates[stateID].calcValues.cumulativeValue = reading;
						this.resetDynamicCostMemory(stateID, reading, beforeReset);

						//At week reset ensure current week values are moved to previous week and current set to 0
						if (beforeReset.week !== actualDate.week) {
							for (const x in weekdays) {

								if (this.config.currentYearDays) {

									// Handle consumption states consumption states
									if (stateDetails.consumption) {
										switch (stateDetails.headCategory) {

											case 'consumed':
												await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.consumed.currentWeek.${weekdays[x]}`, `${stateDetails.deviceName}.currentYear.consumed.previousWeek.${weekdays[x]}`);
												await this.setStateAsync(`${stateDetails.deviceName}.currentYear.consumed.currentWeek.${weekdays[x]}`, {
													val: 0,
													ack: true
												});
												break;

											case 'delivered':
												await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.delivered.currentWeek.${weekdays[x]}`, `${stateDetails.deviceName}.currentYear.delivered.previousWeek.${weekdays[x]}`);
												await this.setStateAsync(`${stateDetails.deviceName}.currentYear.delivered.currentWeek.${weekdays[x]}`, {
													val: 0,
													ack: true
												});
												break;

											default:

										}

									}

									// Handle financial states consumption states
									switch (stateDetails.financialCategory) {

										case 'costs':
											await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.costs.currentWeek.${weekdays[x]}`, `${stateDetails.deviceName}.currentYear.costs.previousWeek.${weekdays[x]}`);
											await this.setStateAsync(`${stateDetails.deviceName}.currentYear.costs.currentWeek.${weekdays[x]}`, {
												val: 0,
												ack: true
											});
											break;

										case 'earnings':
											await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.earnings.currentWeek.${weekdays[x]}`, `${stateDetails.deviceName}.currentYear.earnings.previousWeek.${weekdays[x]}`);
											await this.setStateAsync(`${stateDetails.deviceName}.currentYear.earnings.currentWeek.${weekdays[x]}`, {
												val: 0,
												ack: true
											});
											break;

										default:

									}

									// Handle meter reading states
									await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.meterReadings.currentWeek.${weekdays[x]}`, `${stateDetails.deviceName}.currentYear.meterReadings.previousWeek.${weekdays[x]}`);
									await this.setStateAsync(`${stateDetails.deviceName}.currentYear.meterReadings.currentWeek.${weekdays[x]}`, {
										val: 0,
										ack: true
									});

								}

							}
						}

						// Handle all "previous states"
						if (this.config.currentYearPrevious) {
							// Handle consumption states consumption states
							if (stateDetails.consumption) {
								switch (stateDetails.headCategory) {

									case 'consumed':
										if (beforeReset.day !== actualDate.day) {
											await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.consumed.01_currentDay`,
												`${stateDetails.deviceName}.currentYear.consumed.01_previousDay`);
										}

										if (beforeReset.week !== actualDate.week) {
											await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.consumed.02_currentWeek`, `${stateDetails.deviceName}.currentYear.consumed.02_previousWeek`);
										}

										if (beforeReset.month !== actualDate.month) {
											await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.consumed.03_currentMonth`, `${stateDetails.deviceName}.currentYear.consumed.03_previousMonth`);
										}

										if (beforeReset.quarter !== actualDate.quarter) {
											await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.consumed.04_currentQuarter`, `${stateDetails.deviceName}.currentYear.consumed.04_previousQuarter`);
										}

										if (beforeReset.year !== actualDate.year) {
											await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.consumed.05_currentYear`, `${stateDetails.deviceName}.currentYear.consumed.05_previousYear`);
										}

										break;

									case 'delivered':
										if (beforeReset.day !== actualDate.day) {
											await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.delivered.01_currentDay`, `${stateDetails.deviceName}.currentYear.delivered.01_previousDay`);
										}

										if (beforeReset.week !== actualDate.week) {
											await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.delivered.02_currentWeek`, `${stateDetails.deviceName}.currentYear.delivered.02_previousWeek`);
										}

										if (beforeReset.month !== actualDate.month) {
											await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.delivered.03_currentMonth`, `${stateDetails.deviceName}.currentYear.delivered.03_previousMonth`);
										}

										if (beforeReset.quarter !== actualDate.quarter) {
											await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.delivered.04_currentQuarter`, `${stateDetails.deviceName}.currentYear.delivered.04_previousQuarter`);
										}

										if (beforeReset.year !== actualDate.year) {
											await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.delivered.05_currentYear`, `${stateDetails.deviceName}.currentYear.delivered.05_previousYear`);
										}
										break;

									default:

								}

							}

							// Handle financial states consumption states
							switch (stateDetails.financialCategory) {

								case 'costs':
									if (beforeReset.day !== actualDate.day) {
										await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.costs.01_currentDay`, `${stateDetails.deviceName}.currentYear.costs.01_previousDay`);
									}

									if (beforeReset.week !== actualDate.week) {
										await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.costs.02_currentWeek`, `${stateDetails.deviceName}.currentYear.costs.02_previousWeek`);
									}

									if (beforeReset.month !== actualDate.month) {
										await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.costs.03_currentMonth`, `${stateDetails.deviceName}.currentYear.costs.03_previousMonth`);
									}

									if (beforeReset.quarter !== actualDate.quarter) {
										await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.costs.04_currentQuarter`, `${stateDetails.deviceName}.currentYear.costs.04_previousQuarter`);
									}

									if (beforeReset.year !== actualDate.year) {
										await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.costs.05_currentYear`, `${stateDetails.deviceName}.currentYear.costs.05_previousYear`);
									}
									break;

								case 'earnings':
									if (beforeReset.day !== actualDate.day) {
										await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.earnings.01_currentDay`, `${stateDetails.deviceName}.currentYear.earnings.01_previousDay`);
									}

									if (beforeReset.week !== actualDate.week) {
										await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.earnings.02_currentWeek`, `${stateDetails.deviceName}.currentYear.earnings.02_previousWeek`);
									}

									if (beforeReset.month !== actualDate.month) {
										await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.earnings.03_currentMonth`, `${stateDetails.deviceName}.currentYear.earnings.03_previousMonth`);
									}

									if (beforeReset.quarter !== actualDate.quarter) {
										await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.earnings.04_currentQuarter`, `${stateDetails.deviceName}.currentYear.earnings.04_previousQuarter`);
									}

									if (beforeReset.year !== actualDate.year) {
										await this.setPreviousValues(`${stateDetails.deviceName}.currentYear.earnings.05_currentYear`, `${stateDetails.deviceName}.currentYear.earnings.05_previousYear`);
									}
									break;

								default:

							}

							//ToDo: Think / discuss what to do with meter readings
							// Handle meter reading states
							// if (this.config.currentYearPrevious) await this.setStateAsync(`${stateID}.currentYear.meterReadings.previousWeek.${weekdays[x]}`, {
							// 	val: await this.getStateAsync(`${stateID}.currentYear.meterReadings.previousWeek.${weekdays[x]}`),
							// 	ack: true
							// })
							
							//derelvis
							if (beforeReset.day !== actualDate.day) {
								await this.setPreviousValues(`${stateDetails.deviceName}.cumulativeReading`, `${stateDetails.deviceName}.currentYear.meterReadings.01_previousDay`);
							}

							if (beforeReset.week !== actualDate.week) {
								await this.setPreviousValues(`${stateDetails.deviceName}.cumulativeReading`, `${stateDetails.deviceName}.currentYear.meterReadings.02_previousWeek`);
							}

							if (beforeReset.month !== actualDate.month) {
								await this.setPreviousValues(`${stateDetails.deviceName}.cumulativeReading`, `${stateDetails.deviceName}.currentYear.meterReadings.03_previousMonth`);
							}

							if (beforeReset.quarter !== actualDate.quarter) {
								await this.setPreviousValues(`${stateDetails.deviceName}.cumulativeReading`, `${stateDetails.deviceName}.currentYear.meterReadings.04_previousQuarter`);
							}

							if (beforeReset.year !== actualDate.year) {
								await this.setPreviousValues(`${stateDetails.deviceName}.cumulativeReading`, `${stateDetails.deviceName}.currentYear.meterReadings.05_previousYear`);
							}
							//derelvis end

						}

						await this.extendForeignObject(stateID, obj);
						this.log.info(`Memory values after reset : ${JSON.stringify(this.activeStates[stateID])}`);

					} catch (error) {
						this.errorHandling(`[resetStartValues] ${stateID}`, error);
					}


				}

				// Enable all calculations with timeout of 500 ms
				if (delay) {
					clearTimeout(delay);
					delay = null;
				}
				delay = setTimeout(function () {
					calcBlock = false;
				}, 500);

			});

			resetDay.start();

		} catch (error) {
			this.errorHandling(`[resetStartValues]`, error);
			calcBlock = false; // Continue all calculations
		}

	}

	/**
     * Function to handle previousState values
     * @param {string} currentState - RAW state ID currentValue
     * @param {string} [previousState] - RAW state ID previousValue
     */
	async setPreviousValues(currentState, previousState) {
		// Only set previous state if option is chosen
		try {
			if (this.config.currentYearPrevious) {
				// Check if function input is correctly
				if (currentState && previousState) {
					// Get value of currentState
					const currentVal = await this.getStateAsync(currentState);
					if (currentVal) {
						// Set current value to previous state
						await this.setStateAsync(previousState, {
							val: currentVal.val,
							ack: true
						});
					}
				} else {
					this.log.debug(`[setPreviousValues] invalid data for currentState  ${currentState} and/or previousState ${previousState} received`);
				}
			}
		} catch (e) {
			this.errorHandling(`[setPreviousValues]`, e);
		}

	}

	/**
     * Function to handle state creation
     * @param {string} stateID - RAW state ID of monitored state
     * @param {string} stateRoot - Root folder location
     * @param {string} name - Name of state (also used for state ID !
     * @param {boolean} [atDeviceRoot=FALSE] - store value at root instead of Year-Folder
     * @param {boolean} [deleteState=FALSE] - Set to true will delete the state
     * @param {boolean} [isCurrent=FALSE] - Store value in current Year
	 * @param {string} [forceUnit=''] - Force unit to be set on state
     */
	async doLocalStateCreate(stateID, stateRoot, name, atDeviceRoot, deleteState, isCurrent, forceUnit) {
		this.log.debug(`[doLocalStateCreate] ${stateID} | root : ${stateRoot} | name : ${name}) | atDeviceRoot ${atDeviceRoot} | isCurrent : ${isCurrent}`);

		// Check if stateDetails are preset in memory, other wise abort
		if (this.activeStates[stateID] == null || this.activeStates[stateID].stateDetails == null) return;
		this.log.debug(`[doLocalStateCreate] stateDetails ${stateID} : ${JSON.stringify(this.activeStates[stateID].stateDetails)}`);

		try {
			const stateDetails = this.activeStates[stateID].stateDetails;
			const dateRoot = isCurrent ? `currentYear` : actualDate.year;
			let stateName = null;

			// Common object content
			const commonData = {
				name: name,
				type: 'number',
				role: 'value',
				read: true,
				write: false,
				unit: forceUnit ? forceUnit : stateDetails.useUnit,
				def: 0,
			};

			// Define if state should be created at root level
			if (atDeviceRoot) {
				stateName = `${stateDetails.deviceName}.${stateRoot}`;
				if (!deleteState){
					await this.localSetObject(stateName, commonData);
				} else {
					await this.localDeleteState(stateName);
				}

			} else {

				// Create consumption states
				if (!deleteState && stateDetails.consumption) {
					switch (stateDetails.headCategory) {

						case 'consumed':
							await this.localSetObject(`${stateDetails.deviceName}.${dateRoot}.consumed.${stateRoot}`, commonData);
							await this.localDeleteState(`${stateDetails.deviceName}.${dateRoot}.delivered.${stateRoot}`);
							break;

						case 'delivered':
							await this.localSetObject(`${stateDetails.deviceName}.${dateRoot}.delivered.${stateRoot}`, commonData);
							await this.localDeleteState(`${stateDetails.deviceName}.${dateRoot}.consumed.${stateRoot}`);
							break;

						default:

					}

				} else if (deleteState || !stateDetails.consumption) {

					// If state deletion chosen, clean everything up else define state name
					await this.localDeleteState(`${stateDetails.deviceName}.${dateRoot}.consumed.${stateRoot}`);
					this.log.debug(`Try deleting state ${stateDetails.deviceName}.${dateRoot}.consumed.${stateRoot}`);
					await this.localDeleteState(`${stateDetails.deviceName}.${dateRoot}.delivered.${stateRoot}`);
					this.log.debug(`Try deleting state ${stateDetails.deviceName}.${dateRoot}.delivered.${stateRoot}`);

				}

				// Create MeterReading states
				if (!deleteState && stateDetails.meter_values) {

					// Do not create StateRoot values
					if (!basicStates.includes(stateRoot)) {
						await this.localSetObject(`${stateDetails.deviceName}.${dateRoot}.meterReadings.${stateRoot}`, commonData);
					}

				} else if (deleteState || !stateDetails.meter_values) {

					// If state deletion chosen, clean everything up else define state name
					await this.localDeleteState(`${stateDetails.deviceName}.${dateRoot}.meterReadings.${stateRoot}`);

				}

				// Create cost states
				if (!deleteState && stateDetails.costs) {

				    //Use cost unit as defined in admin settings (currency)
					commonData.unit = useCurrency; // Switch Unit to money

					switch (stateDetails.financialCategory) {

						case 'costs':
							// await this.ChannelCreate(device, head_category, head_category);
							await this.localSetObject(`${stateDetails.deviceName}.${dateRoot}.costs.${stateRoot}`, commonData);
							await this.localDeleteState(`${stateDetails.deviceName}.${dateRoot}.earnings.${stateRoot}`);
							break;

						case 'earnings':
							// await this.ChannelCreate(device, head_category, head_category);
							await this.localSetObject(`${stateDetails.deviceName}.${dateRoot}.earnings.${stateRoot}`, commonData);
							await this.localDeleteState(`${stateDetails.deviceName}.${dateRoot}.costs.${stateRoot}`);
							break;

						default:

					}

				} else if (!stateDetails.costs) {

					// If state deletion chosen, clean everything up else define state name
					await this.localDeleteState(`${stateDetails.deviceName}.${dateRoot}.costs.${stateRoot}`);
					this.log.debug(`Try deleting state ${stateDetails.deviceName}.${dateRoot}.costs.${stateRoot}`);
					await this.localDeleteState(`${stateDetails.deviceName}.${dateRoot}.earnings.${stateRoot}`);
					this.log.debug(`Try deleting state ${stateDetails.deviceName}.${dateRoot}.earnings.${stateRoot}`);
				}
			}

		} catch (error) {
			// Send code failure to sentry
			this.errorHandling(`[localStateCreate] ${stateID}`, error);
		}
	}

	/**
	 * create/extend function for objects
	 * @param {string} stateName - RAW state ID of monitored state
	 * @param {object} commonData - common data content
	 */
	async localSetObject(stateName, commonData) {
		this.validStates[stateName] = commonData;
		// Ensure name and unit changes are propagated
		await this.extendObjectAsync(stateName, {
			type: 'state',
			common: {
				name: commonData.name,
				unit: commonData.unit,
				type: 'number',
				def : 0
			},
			native: {},
		});
	}

	/**
	 * proper deletion of state and object
	 * @param {string} stateName - RAW state ID of monitored state
	 */
	async localDeleteState(stateName) {
		try {
			if (stateDeletion) {
				const obj = await this.getObjectAsync(stateName);
				if (obj) {
					await this.delObjectAsync(stateName);
				}
			}
		} catch (error) {
			// do nothing
		}
	}

	/**
     *Logic to handle all calculations
     *  @param {string} [stateID] - state id of source value
     *  @param {object} [stateVal] - object with current value (val) and timestamp (ts)
     */
	async calculationHandler(stateID, stateVal) {
		try {
			this.log.debug(`[calculationHandler] Calculation for ${stateID} with values : ${JSON.stringify(stateVal)}`);
			this.log.debug(`[calculationHandler] Configuration : ${JSON.stringify(this.activeStates[stateID])}`);

			// Verify if received value is null or undefined
			if (!stateVal){
				this.log.error(`Input value for ${stateID} with ${JSON.stringify((stateVal))} is null or undefined, cannot continue calculation`);
				return;
			}

			// Verify if received value is null or undefined
			if (!stateID){
				// Cancel operation when function iis called with empty stateID
				return;
			}

			// Check if for some reason calculation handler ist called for an object not initialised
			if (!this.activeStates[stateID]){

				this.errorHandling(`calculationHandler`, `Called for non-initialised state ${stateID}`);
				return;
			}

			const calcValues = this.activeStates[stateID].calcValues;
			const stateDetails = this.activeStates[stateID].stateDetails;
			const statePrices = this.activeStates[stateID].prices;
			const currentCath = this.unitPriceDef.unitConfig[stateDetails.stateUnit].category;
			const targetCath = this.unitPriceDef.unitConfig[stateDetails.useUnit].category;
			const date = new Date();
			const readingTimestamp = this.getStateChangeTimestamp(stateVal);

			this.log.debug(`[calculationHandler] calcValues : ${JSON.stringify(calcValues)}`);
			this.log.debug(`[calculationHandler] stateDetails : ${JSON.stringify(stateDetails)}`);
			this.log.debug(`[calculationHandler] statePrices : ${JSON.stringify(statePrices)}`);
			this.log.debug(`[calculationHandler] currentCath : ${JSON.stringify(currentCath)}`);
			this.log.debug(`[calculationHandler] targetCath : ${JSON.stringify(targetCath)}`);

			let stateName = `${this.namespace}.${stateDetails.deviceName}`;

			// Define proper calculation value
			let reading;

			// Convert volume liter to cubic
			//TODO 0.5: Should  be handle  by library
			if (currentCath === 'Watt') {
				// Convert watt to watt-hours
				reading = await this.wattToWattHour(stateID, stateVal);
				if (reading === null || reading === undefined) return;
			} else if (currentCath === 'Liter' && targetCath === 'Cubic_meter') {
				reading = stateVal.val / 1000;
			} else if (currentCath === 'Cubic_meter' && targetCath === 'Liter'
			) {
				reading = stateVal.val * 1000;
			} else {
				reading = stateVal.val;
			}

			this.log.debug(`[calculationHandler] value : ${JSON.stringify(reading)}`);
			if (reading === null || reading === undefined) {
				this.log.error(`[calculationHandler] reading incorrect after conversion contact DEV and provide these info | Reading : ${JSON.stringify(reading)} | start reading ${JSON.stringify(stateVal)} | stateDetails ${JSON.stringify(stateDetails)}`);
				return;
			}

			const currentExponent = this.unitPriceDef.unitConfig[stateDetails.stateUnit].exponent;
			const targetExponent = this.unitPriceDef.unitConfig[stateDetails.useUnit].exponent;
			this.log.debug(`[calculationHandler] Reading value ${reading} before exponent multiplier | currentExponent : ${JSON.stringify(currentExponent)} | targetExponent : ${JSON.stringify(targetExponent)}`);
			// Logic to handle exponents and handle watt reading
			if (typeof (reading) === 'number' || reading === 0) {
				if (currentCath === 'Watt') {
					// Add calculated watt reading to stored totals
					reading = (reading * Math.pow(10, (currentExponent - targetExponent))) + calcValues.cumulativeValue;
				} else {
					reading = reading * Math.pow(10, (currentExponent - targetExponent));
				}
			} else {
				this.log.error(`Input value for ${stateID}, type = ${typeof reading} but should be a number, cannot handle calculation`);
				return;
			}

			if (reading === null || reading === undefined) {
				this.log.error(`[calculationHandler] reading incorrect after Exponent conversion contact DEV and provide these info | Reading : ${JSON.stringify(reading)} | start reading ${JSON.stringify(stateVal)} | currentExponent ${currentExponent} | targetExponent ${targetExponent} | stateDetails ${stateDetails}`);
				return;
			}

			this.log.debug(`[calculationHandler] reading value ${reading} after exponent multiplier : ${JSON.stringify(targetExponent)}`);

			// Check if state was already initiated
			// Function to initiate proper memory values at device init and value reset
			const initiateState = async () => {
				// Prepare object array for extension
				const obj = {};
				obj.common = {};
				obj.common.custom = {};
				obj.common.custom[this.namespace] = {};

				// Determine previous reset value
				// If null (first init) set 0 to valueAtDeviceReset otherwise copy current value
				if (calcValues.valueAtDeviceReset == null){
					// Update memory value with valueAtDeviceReset 0 and current reading at init
					obj.common.custom[this.namespace].valueAtDeviceReset = 0;
					obj.common.custom[this.namespace].valueAtDeviceInit = reading;
				} else  {
					// Update memory value with  known valueAtDeviceReset and current reading at init
					obj.common.custom[this.namespace].valueAtDeviceReset = calcValues.cumulativeValue;
					obj.common.custom[this.namespace].valueAtDeviceInit = reading;
				}

				// Update memory value with current & init value at object and memo
				this.log.debug(`[calculationHandler] Extend object with  ${JSON.stringify(obj)} `);
				await this.extendForeignObject(stateID, obj);
			};

			// Verify if state is initiated for the first time, if not handle initialisation
			if (calcValues.valueAtDeviceReset == null && currentCath !== 'Watt'){
				this.log.info(`Initiating ${stateID} for the first time in SourceAnalytix`);
				await initiateState();

			// State was already initiated, current value >= known cumulative process normally
			} else if (((reading + calcValues.valueAtDeviceReset) >= calcValues.cumulativeValue) && currentCath !== 'Watt') {
				this.log.debug(`[calculationHandler] New reading ${reading} bigger than stored value ${calcValues.valueAtDeviceInit} processing normally`);
				this.log.debug(`[calculationHandler] Adding ${reading} to stored value ${this.activeStates[stateID].calcValues.valueAtDeviceReset}`);

				// Add current reading to value in memory
				reading = reading + this.activeStates[stateID].calcValues.valueAtDeviceReset;

				this.log.debug(`[calculationHandler] Calculation outcome ${reading} valueAtDeviceReset ${this.activeStates[stateID].calcValues.valueAtDeviceReset}`);

			// State was already initiated, current value < known cumulative process normally
			} else if (((reading + calcValues.valueAtDeviceReset) < calcValues.cumulativeValue) && currentCath !== 'Watt') {

				// Only handle device reset if activated (default = TRUE) & reading + threshold value < cumulativeValue
				if (stateDetails.deviceResetLogicEnabled && ((reading + calcValues.valueAtDeviceReset + stateDetails.threshold) < calcValues.cumulativeValue) ){
					this.log.warn(`Device reset detected for ${stateID} store current cumulatedReading ${calcValues.cumulativeValue} as valueAtDeviceReset (previous valueAtDeviceReset : ${calcValues.valueAtDeviceReset})`);
					await initiateState();
				} else {
					this.log.info(`Device reset detected for ${stateID}, feature disabled processing normally)`);
				}

				reading = reading + this.activeStates[stateID].calcValues.valueAtDeviceReset;
			} else if (currentCath !== 'Watt') {
				this.log.error(`[calculationHandler] unforeseen situation for ${stateID} with value ${reading}, please send this to developer | reading : ${reading} | calcvalues : ${JSON.stringify(stateDetails)}`);
			}

			this.log.debug(`[calculationHandler] ${stateID} set cumulated value ${reading}`);
			// Update current value to memory
			this.activeStates[stateID]['calcValues'].cumulativeValue = reading;
			// this.visWidgetJson[stateID].cumulativeValue = reading;
			this.log.debug(`[calculationHandler] ActiveStatesArray ${JSON.stringify(this.activeStates[stateID])})`);

			// Write current reading at device root
			await this.setStateChangedAsync(`${stateDetails.deviceName}.cumulativeReading`, {
				val: reading,
				ack: true
			});

			// Write current reading at year statistics
			if (this.config.store_weeks || this.config.store_months || 	this.config.store_quarters){
				await this.setStateChangedAsync(`${stateDetails.deviceName}.${actualDate.year}.readingCumulative`, {
					val: reading,
					ack: true
				});
			}

			//TODO 0.5; implement counters
			// 	// Handle impulse counters
			// 	if (obj_custom.state_type == 'impulse'){

			// 		// cancel calculation in case of impulse counter
			// 		return;

			// 	}

			//TODO 0.5: Implement periods
			// temporary set to Zero, this value will be used later to handle period calculations
			const reading_start = 0; //obj_cust.start_meassure;
			const parsedUnitPrice = this.parsePriceValue(statePrices.unitPrice);
			const unitPrice = parsedUnitPrice === null ? 0 : parsedUnitPrice;
			if (stateDetails.costs && parsedUnitPrice === null) {
				this.log.warn(`[calculationHandler] Unit price ${JSON.stringify(statePrices.unitPrice)} for ${stateID} is not numeric, using 0 to avoid invalid cost calculations`);
			}

			this.log.debug(`[calculationHandler] PreviousCalculationRounded for ${stateID} : ${JSON.stringify(previousCalculationRounded[stateID])}`);

			// Store meter values
			if (stateDetails.meter_values === true) {
				// Always write generic meterReadings for current year
				stateName = `${this.namespace}.${stateDetails.deviceName}.currentYear.meterReadings`;
				const readingRounded = await this.roundDigits(reading);

				// Store meter reading to related period
				if (readingRounded) {
					await this.setStateChangedAsync(`${stateName}.currentWeek.${weekdays[date.getDay()]}`, {
						val: readingRounded,
						ack: true
					});
					stateName = `${`${this.namespace}.${stateDetails.deviceName}`}.${actualDate.year}.meterReadings`;
					if (storeSettings.storeWeeks) await this.setStateChangedAsync(`${stateName}.weeks.${actualDate.week}`, {
						val: readingRounded,
						ack: true
					});
					// Month
					if (storeSettings.storeMonths) await this.setStateChangedAsync(`${stateName}.months.${actualDate.month}`, {
						val: readingRounded,
						ack: true
					});
					// Quarter
					if (storeSettings.storeQuarters) await this.setStateChangedAsync(`${stateName}.quarters.Q${actualDate.quarter}`, {
						val: readingRounded,
						ack: true
					});
				}
			}

			// Handle calculations
			const calculations = {
				consumedDay: ((reading - calcValues.start_day) - reading_start),
				consumedWeek: ((reading - calcValues.start_week) - reading_start),
				consumedMonth: ((reading - calcValues.start_month) - reading_start),
				consumedQuarter: ((reading - calcValues.start_quarter) - reading_start),
				consumedYear: ((reading - calcValues.start_year) - reading_start),
				priceDay: unitPrice * ((reading - calcValues.start_day) - reading_start),
				priceWeek: unitPrice * ((reading - calcValues.start_week) - reading_start),
				priceMonth: unitPrice * ((reading - calcValues.start_month) - reading_start),
				priceQuarter: unitPrice * ((reading - calcValues.start_quarter) - reading_start),
				priceYear: unitPrice * ((reading - calcValues.start_year) - reading_start),
			};

			this.log.debug(`[calculationHandler] Result of calculation: ${JSON.stringify(calculations)}`);

			// Handle rounding of values
			const calculationRounded = {
				consumedDay: await this.roundDigits(calculations.consumedDay),
				consumedWeek: await this.roundDigits(calculations.consumedWeek),
				consumedMonth: await this.roundDigits(calculations.consumedMonth),
				consumedQuarter: await this.roundDigits(calculations.consumedQuarter),
				consumedYear: await this.roundDigits(calculations.consumedYear),
				priceDay: await this.roundCosts(unitPrice * calculations.consumedDay),
				priceWeek: await this.roundCosts(unitPrice * calculations.consumedWeek),
				priceMonth: await this.roundCosts(unitPrice * calculations.consumedMonth),
				priceQuarter: await this.roundCosts(unitPrice * calculations.consumedQuarter),
				priceYear: await this.roundCosts(unitPrice * calculations.consumedYear),
			};

			if (this.isDynamicPriceState(stateID)) {
				const dynamicCalculationRounded = await this.calculateDynamicCostsForState(stateID, reading, readingTimestamp);
				if (dynamicCalculationRounded) {
					calculationRounded.priceDay = dynamicCalculationRounded.priceDay;
					calculationRounded.priceWeek = dynamicCalculationRounded.priceWeek;
					calculationRounded.priceMonth = dynamicCalculationRounded.priceMonth;
					calculationRounded.priceQuarter = dynamicCalculationRounded.priceQuarter;
					calculationRounded.priceYear = dynamicCalculationRounded.priceYear;
				}
			}

			// this.visWidgetJson[stateID].date = calculationRounded;
			this.log.debug(`[calculationHandler] Result of rounding: ${JSON.stringify(calculations)}`);

			// Store consumption
			if (stateDetails.consumption) {
				// Always write generic meterReadings for current year
				stateName = `${this.namespace}.${stateDetails.deviceName}.currentYear.${stateDetails.headCategory}`;
				// Generic
				await this.setStateChangedAsync(`${stateName}.01_currentDay`, {
					val: calculationRounded.consumedDay,
					ack: true
				});
				await this.setStateChangedAsync(`${stateName}.02_currentWeek`, {
					val: calculationRounded.consumedWeek,
					ack: true
				});
				await this.setStateChangedAsync(`${stateName}.03_currentMonth`, {
					val: calculationRounded.consumedMonth,
					ack: true
				});
				await this.setStateChangedAsync(`${stateName}.04_currentQuarter`, {
					val: calculationRounded.consumedQuarter,
					ack: true
				});
				await this.setStateChangedAsync(`${stateName}.05_currentYear`, {
					val: calculationRounded.consumedYear,
					ack: true
				});
				if (this.config.store_weeks || this.config.store_months || this.config.store_quarters) {
					await this.setStateChangedAsync(`${this.namespace}.${stateDetails.deviceName}.${actualDate.year}.${stateDetails.headCategory}Cumulative`, {
						val: calculationRounded.consumedYear,
						ack: true
					});
				}

				// Weekdays
				//ToDo 0.4.9 : Write to JSON
				await this.setStateChangedAsync(`${stateName}.currentWeek.${weekdays[date.getDay()]}`, {
					val: calculationRounded.consumedDay,
					ack: true
				});


				stateName = `${this.namespace}.${stateDetails.deviceName}.${actualDate.year}.${stateDetails.headCategory}`;
				// Week
				if (storeSettings.storeWeeks) await this.setStateChangedAsync(`${stateName}.weeks.${actualDate.week}`, {
					val: calculationRounded.consumedWeek,
					ack: true
				});
				// Month
				if (storeSettings.storeMonths) await this.setStateChangedAsync(`${stateName}.months.${actualDate.month}`, {
					val: calculationRounded.consumedMonth,
					ack: true
				});
				// Quarter
				if (storeSettings.storeQuarters) await this.setStateChangedAsync(`${stateName}.quarters.Q${actualDate.quarter}`, {
					val: calculationRounded.consumedQuarter,
					ack: true
				});

			}

			// Store prices
			if (stateDetails.costs) {
				await this.writeFinancialStates(stateID, calculationRounded, date);

			}

			// Store results of current calculation to memory
			//ToDo 0.4.9 : Build JSON array for current values to have widget & information easy accessible in vis
			previousCalculationRounded[stateID] = calculationRounded;

			this.log.debug(`[calculationHandler] Meter Calculation executed consumed data for ${stateID} : ${JSON.stringify(calculationRounded)}`);


		} catch (error) {
			this.errorHandling(`[calculationHandler] ${stateID} with config ${JSON.stringify(this.activeStates[stateID])}`, error);
		}

	}

	/**
	 *	Initiate json array for vis widget
	 *  @param {string} [stateID] - state id of source value
	 */
	// async buildVisWidgetJson(stateID){
	// 	this.log.debug(`[buildVisWidgetJson] Start building VisWidgetJson for ${stateID}`);
	// 	this.visWidgetJson[stateID] = {
	// 		unit: this.activeStates[stateID].stateDetails.useUnit,
	// 		currency: useCurrency
	// 	};
	// 	this.log.debug(`[buildVisWidgetJson] ${stateID} : ${JSON.stringify(this.visWidgetJson[stateID])}`);
	// }

	/**
     * @param {number} [value] - Number to round with , separator
     */
	async roundDigits(value) {
		let rounded;
		try {
			rounded = Number(value);
			rounded = Math.round(rounded * 1000) / 1000;
			this.log.debug(`roundDigits with ${value} rounded ${rounded}`);
			if (!rounded) return value;
			return rounded;
		} catch (error) {
			this.errorHandling(`[roundDigits] ${value}`, error);
			rounded = value;
			return rounded;
		}
	}

	/**
     * @param {number} [value] - Number to round with . separator
     */
	async roundCosts(value) {
		try {
			const numericValue = Number(value);
			if (!Number.isFinite(numericValue)) {
				this.log.warn(`roundCosts received non-numeric value ${JSON.stringify(value)}, returning 0`);
				return 0;
			}
			let rounded = numericValue;
			rounded = Math.round(rounded * 100) / 100;
			this.log.debug(`roundCosts with ${value} rounded ${rounded}`);
			return rounded;
		} catch (error) {
			this.errorHandling(`[roundCosts] ${value}`, error);
			return 0;
		}
	}

	/**
     * @param {string} [stateID]- ID of state
     * @param {object} [value] - Current value in wH
     */
	async wattToWattHour(stateID, value) {
		try {

			const calcValues = this.activeStates[stateID].calcValues;

			this.log.debug(`[wattToWattHour] Watt to kWh, current reading : ${value.val} previousReading : ${JSON.stringify(calcValues)}`);

			// Prepare needed data to handle calculations
			const readingData = {
				previousReadingWatt: Number(calcValues.previousReadingWatt),
				previousReadingWattTs: Number(calcValues.previousReadingWattTs),
				currentReadingWatt: Number(value.val),
				currentReadingWattTs: Number(value.ts),
			};

			// Prepare function return
			let calckWh;

			if (readingData.previousReadingWatt && readingData.previousReadingWattTs) {

				// Calculation logic W to kWh
				calckWh = (((readingData.currentReadingWattTs - readingData.previousReadingWattTs)) * readingData.previousReadingWatt / 3600000);
				this.log.debug(`[wattToWattHour] ${stateID} result of watt to kWh calculation : ${calckWh}`);

				// Update timestamp current reading to memory
				this.activeStates[stateID]['calcValues'].previousReadingWatt = readingData.currentReadingWatt;
				this.activeStates[stateID]['calcValues'].previousReadingWattTs = readingData.currentReadingWattTs;

			} else {

				this.log.debug(`[wattToWattHour] No previous reading available, store current to memory`);

				// Update timestamp current reading to memory
				this.activeStates[stateID]['calcValues'].previousReadingWatt = readingData.currentReadingWatt;
				this.activeStates[stateID]['calcValues'].previousReadingWattTs = readingData.currentReadingWattTs;
				calckWh = 0; // return 0 kWh consumption as measurement

			}

			this.log.debug(`[wattToWattHour] ${stateID} Watt to kWh outcome : ${JSON.stringify(this.activeStates[stateID].calcValues)}`);
			return calckWh;
		} catch (error) {
			this.errorHandling(`[wattToWattHour] ${stateID}`, error);
		}
	}

	/**
     * @param {string} [stateID]- ID of state
     * @param {object} [deviceName] - Name of device
     */
	async getCumulatedValue(stateID, deviceName) {
		this.log.debug(`[getCumulatedValue] ${stateID }`);
		let valueSource; // For debugging purpose
		let currentCumulated; // Cumulated value

		// Check if previous reading exist in state
		currentCumulated = await this.getStateAsync(`${deviceName}.cumulativeReading`);
		// Check if value exist in cumulativeReading state (Version >= 0.4.8-alpha5)
		if (!currentCumulated || currentCumulated.val === 0) {

			// If values does not exist or is 0, check Current_Reading (pre 0.4.8-alpha 5!)
			currentCumulated = await this.getStateAsync(`${deviceName}.Current_Reading`);
			if (!currentCumulated || currentCumulated.val === 0) {
				currentCumulated = await this.getStateAsync(`${deviceName}.Meter_Readings.Current_Reading`);
				// If values does not exist or is 0, check Current_Reading (pre 0.4.0)
				if (!currentCumulated || currentCumulated.val === 0) {
					valueSource = 'Fresh installation';
					currentCumulated = 0;

				} else {
					valueSource = 'Version < 4';
					currentCumulated = currentCumulated.val;
				}
			} else {
				valueSource = 'Version <= 0.4.8-alpha7';
				currentCumulated = currentCumulated.val;
			}

		} else {
			// Cumulative present and not 0, process normally
			currentCumulated = currentCumulated.val;
			valueSource = 'Version >= 0.4.8-alpha7';
		}
		this.log.debug(`[getCumulatedValue] By using ${valueSource} :${currentCumulated}`);
		return currentCumulated;
	}

	/**
     * Load current dates (year, week, month, quarter, day)
     */
	async refreshDates() {
	    // Get current date
		const today = new Date(); // Get current date in Unix time format
		// Store current used dates to memory
		const previousDates = {
			day: actualDate.day,
			week: actualDate.week,
			month: actualDate.month,
			quarter: actualDate.quarter,
			year: actualDate.year
		};

		// Write current dates to memory
		actualDate.day = weekdays[today.getDay()];
		actualDate.week = this.getWeekNumber(today);
		actualDate.month = months[today.getMonth()];
		actualDate.quarter = Math.floor((today.getMonth() + 3) / 3);
		actualDate.year = (new Date().getFullYear());

		return previousDates;
	}

	/**
     * define proper week-number, add 0 in case of < 10
     * @param {object} d - Current date (like initiated with new Date())
     */
	getWeekNumber(d) {
		// Copy date so don't modify original
		d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
		// Set to nearest Thursday: current date + 4 - current day number
		// Make Sunday's day number 7
		d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
		// Get first day of year
		const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
		// Calculate full weeks to nearest Thursday
		// @ts-ignore subtracting dates is fine
		let weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7).toString();

		if (weekNo.length === 1) {
			weekNo = '0' + weekNo;
		}
		// Return week number
		return weekNo;
	}

	/**
     * @param {string} [codePart]- Message Prefix
     * @param {object} [error] - Sentry message
     */
	errorHandling(codePart, error) {
		const msg = `[${codePart}] error: ${error.message}, stack: ${error.stack}`;
		if (!disableSentry) {
			if (this.supportsFeature && this.supportsFeature('PLUGINS')) {
				const sentryInstance = this.getPluginInstance('sentry');
				if (sentryInstance) {
					this.log.info(`[Error caught and sent to Sentry, thank you for collaborating!] error: ${msg}`);
					sentryInstance.getSentryObject().captureException(msg);
				}
			}
		} else {
			this.log.error(`Sentry disabled, error caught : ${msg}`);
			console.error(`Sentry disabled, error caught : ${msg}`);
		}
	}

	//Function to handle messages from State settings and provide Unit and Price definitions
	async onMessage(obj) {

		if (obj) {
			switch (obj.command) {
				case 'getPriceDefinitions':
					if (obj.callback) {

						const priceDefinitionArray = [];
						for (const priceDefinition in this.unitPriceDef.pricesConfig){
							priceDefinitionArray.push({label: priceDefinition, value: priceDefinition});
						}
						this.sendTo(obj.from, obj.command, priceDefinitionArray, obj.callback);
					}
					break;

				case 'getUnits':
					if (obj.callback) {

						const unitArray = [];

						unitArray.push({label: 'Detect automatically', value: 'Detect automatically'});
						for (const priceDefinition in this.unitPriceDef.unitConfig){
							unitArray.push({label: priceDefinition, value: priceDefinition});
						}
						this.sendTo(obj.from, obj.command, unitArray, obj.callback);
					}
					break;
			}
		}
	}

	/**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
	onUnload(callback) {
		try {
			this.log.info(`SourceAnalytix stopped, now you have to calculate by yourself :'( ...`);
			callback();
		} catch (e) {
			callback();
		}
	}

}

//@ts-ignore .parent exists
if (module.parent) {
	// Export the constructor in compact mode
	/**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
	module.exports = (options) => new Sourceanalytix(options);
} else {
	// otherwise start the instance directly
	new Sourceanalytix();

}
