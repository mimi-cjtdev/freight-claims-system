/**
 * Rules.gs — the business rules the workflows enforce.
 *
 * Not published in this repository (kept private):
 *   - Config.gs   sheet design: tab names (TABS), column layout, dropdowns,
 *                 checkbox columns (CHECKBOX_COLUMNS), formats, and the intake
 *                 form's question titles (FORM_FIELDS)
 *   - Setup.gs    builds the sheet and the Google Form, installs the triggers
 *   - Triggers.gs custom menu and the edit dispatcher that routes sheet edits
 *                 to the handlers in Workflows.gs
 */

const COMPANY = 'Mimi-D Logistics';
const TZ = 'Asia/Manila';
const DATETIME_FORMAT = 'MMM d, yyyy, h:mm a';   // Slack messages
const DAY_FORMAT = 'MMM d, yyyy';                // Slack messages

// The 9-month filing window follows the Carmack Amendment (49 U.S.C. § 14706).
// The 30-day acknowledgment and 120-day response limits follow 49 CFR Part 370.
const RULES = {
  MEDIUM_PRIORITY_AMOUNT: 1000,
  HIGH_PRIORITY_AMOUNT: 5000,       // or any Loss
  AUTO_ESCALATE_AMOUNT: 10000,      // Critical: escalated to the Claims Manager at intake
  FILING_WINDOW_MONTHS: 9,
  CARRIER_ACK_DAYS: 30,
  CARRIER_RESPONSE_DAYS: 120,
  FILING_WARNING_DAYS: 30,          // monitor warns when the filing deadline is this close
  FILING_URGENT_DAYS: 7,
  UNASSIGNED_ALERT_DAYS: 2,
};

/** Documents that must be checked off before a claim can be filed with the carrier. */
const REQUIRED_DOCS = {
  'Damage': ['BOL', 'POD', 'Photos', 'Invoice'],
  'Shortage': ['BOL', 'POD', 'Invoice'],
  'Loss': ['BOL', 'Invoice'],
  'Delay': ['BOL', 'POD', 'Invoice'],
  'Refused Delivery': ['BOL', 'POD', 'Invoice'],
  'Temperature Excursion': ['BOL', 'POD', 'Photos', 'Invoice'],
  'Other': ['BOL', 'Invoice'],
};

/** Claim lifecycle. */
const STATUS = {
  NEW: 'New',
  REVIEW: 'In Review',
  FILED: 'Filed with Carrier',
  ESCALATED: 'Escalated',
  DISPUTE: 'In Dispute',
  CLOSED: 'Closed',
};

const DECISIONS = ['Paid in Full', 'Partial Settlement', 'Declined'];
const DISPUTABLE_DECISIONS = ['Partial Settlement', 'Declined'];
const DISPUTE_OUTCOMES = ['Reversed', 'Upheld'];

const DECISION_EMOJI = { 'Paid in Full': '✅', 'Partial Settlement': '🟡', 'Declined': '❌' };
const PRIORITY_EMOJI = { 'Critical': '🔴', 'High': '🟠', 'Medium': '🟡', 'Low': '⚪' };
