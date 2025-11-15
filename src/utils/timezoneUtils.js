const { format, parseISO } = require('date-fns');
const { toZonedTime, formatInTimeZone } = require('date-fns-tz');

const AEST_TIMEZONE = 'Australia/Sydney';

class TimezoneUtils {
    /**
     * Get current time in AEST
     * Since we're storing AEST directly in the database,
     * this returns the current time converted to AEST
     * @returns {Date} - Current time in AEST
     */
    static nowInAEST() {
        return toZonedTime(new Date(), AEST_TIMEZONE);
    }

    /**
     * Format a date in AEST timezone
     * @param {Date|string} date - Date to format
     * @param {string} formatString - Format string (default: 'yyyy-MM-dd HH:mm:ss zzz')
     * @returns {string} - Formatted date string in AEST
     */
    static formatAEST(date, formatString = 'yyyy-MM-dd HH:mm:ss zzz') {
        const dateObj = typeof date === 'string' ? parseISO(date) : date;
        return formatInTimeZone(dateObj, AEST_TIMEZONE, formatString);
    }

    /**
     * Display database timestamp (already in AEST)
     * @param {Date|string} timestamp - Database timestamp (AEST)
     * @returns {string} - Formatted string
     */
    static displayAEST(timestamp) {
        if (!timestamp) return '';
        const dateObj = typeof timestamp === 'string' ? parseISO(timestamp) : timestamp;
        return format(dateObj, 'dd/MM/yyyy HH:mm:ss');
    }

    /**
     * Get date string for Salesforce (already AEST, just format as ISO)
     * @param {Date|string} date - Date to format
     * @returns {string} - ISO string
     */
    static toSalesforceDate(date) {
        if (!date) return null;
        const dateObj = typeof date === 'string' ? parseISO(date) : date;
        return format(dateObj, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
    }

}

module.exports = TimezoneUtils;