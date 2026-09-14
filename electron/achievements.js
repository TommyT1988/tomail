'use strict';
const LIST = [
  { id: 'inbox-zero', title: 'Inbox zero', body: 'Not a single unread message in your inbox.', test: (a) => a.inboxTotal > 0 && a.inboxUnread === 0 },
  { id: 'empty-inbox', title: 'Clean desk', body: 'Nothing left in the inbox at all.', test: (a) => a.inboxTotal === 0 && a.sentTotal > 0 },
  { id: 'replies-10', title: 'Chatty', body: '10 messages sent this week.', test: (a) => a.sentWeek >= 10 },
  { id: 'replies-50', title: 'Correspondent', body: '50 messages sent this week.', test: (a) => a.sentWeek >= 50 },
  { id: 'replies-100', title: 'Mail machine', body: '100 messages sent in a week. Take a break.', test: (a) => a.sentWeek >= 100 },
  { id: 'archived-100', title: 'Tidy', body: '100 messages archived.', test: (a) => a.archivedTotal >= 100 },
  { id: 'archived-1000', title: 'Archivist', body: '1,000 messages archived.', test: (a) => a.archivedTotal >= 1000 },
  { id: 'archived-10000', title: 'Librarian', body: '10,000 messages archived. Respect.', test: (a) => a.archivedTotal >= 10000 },
  { id: 'snooze-10', title: 'Later, alligator', body: 'Snoozed 10 messages.', test: (a) => a.snoozedTotal >= 10 },
  { id: 'rules-5', title: 'Automator', body: 'Five rules doing your filing for you.', test: (a) => a.rules >= 5 },
  { id: 'early-bird', title: 'Early bird', body: 'Sent mail before 7 in the morning.', test: (a) => a.earliestSentHour != null && a.earliestSentHour < 7 },
  { id: 'night-owl', title: 'Night owl', body: 'Sent mail after 11 at night.', test: (a) => a.latestSentHour != null && a.latestSentHour >= 23 },
  { id: 'followup-5', title: 'Persistent', body: 'Closed five follow-ups.', test: (a) => a.followupsDone >= 5 },
];
/** Returns newly unlocked achievements given activity + the set already unlocked. */
function evaluate(activity, unlocked) {
  return LIST.filter(x => !unlocked[x.id] && x.test(activity));
}
module.exports = { LIST, evaluate };
