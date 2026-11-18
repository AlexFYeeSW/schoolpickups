// Sample data used until Supabase is connected. All names are made up.
// Shape matches supabase/schema.sql so swapping in real data is a drop-in change.

const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri"];

export const base = { id: "base", name: "Afterschool Center" };

export const schools = [
  // dismissal: minutes after midnight per weekday (e.g. 900 = 3:00 PM)
  { id: "maple", name: "Maple Elementary", dismissal: { mon: 900, tue: 900, wed: 810, thu: 900, fri: 900 } },
  { id: "cedar", name: "Cedar Grove Elementary", dismissal: { mon: 885, tue: 885, wed: 795, thu: 885, fri: 885 } },
  { id: "lincoln", name: "Lincoln Park Elementary", dismissal: { mon: 915, tue: 915, wed: 915, thu: 915, fri: 840 } },
  { id: "riverside", name: "Riverside Middle", dismissal: { mon: 930, tue: 930, wed: 870, thu: 930, fri: 930 } },
  { id: "hillcrest", name: "Hillcrest Elementary", dismissal: { mon: 900, tue: 900, wed: 900, thu: 900, fri: 900 } },
];

// Driving minutes between locations (symmetric).
export const travelMinutes = {
  base: { maple: 8, cedar: 10, lincoln: 6, riverside: 12, hillcrest: 9 },
  maple: { cedar: 7, lincoln: 9, riverside: 11, hillcrest: 5 },
  cedar: { lincoln: 8, riverside: 6, hillcrest: 10 },
  lincoln: { riverside: 10, hillcrest: 7 },
  riverside: { hillcrest: 13 },
};

export const drivers = [
  { id: "d1", name: "Driver A", seats: 7, days: ALL_DAYS },
  { id: "d2", name: "Driver B", seats: 7, days: ALL_DAYS },
  { id: "d3", name: "Driver C", seats: 10, days: ALL_DAYS },
  { id: "d4", name: "Driver D", seats: 12, days: ["mon", "tue", "wed", "thu"] },
];

const firstNames = [
  "Ava", "Liam", "Mia", "Noah", "Zoe", "Eli", "Luna", "Owen", "Ivy", "Leo",
  "Nora", "Kai", "Ruby", "Finn", "Maya", "Jude", "Isla", "Theo", "Lila", "Max",
  "Aria", "Sam", "Elle", "Ben", "Rosa", "Dev", "Jade", "Omar", "Tess", "Ian",
  "Gia", "Ray", "Nia", "Cole", "Ana", "Jay", "Lucy", "Ezra", "Mae", "Rex",
];
const schoolOrder = ["maple", "cedar", "lincoln", "riverside", "hillcrest"];

export const students = firstNames.map((first, i) => ({
  id: `s${String(i + 1).padStart(2, "0")}`,
  name: `${first} ${String.fromCharCode(65 + ((i * 7) % 26))}.`,
  schoolId: schoolOrder[i % schoolOrder.length],
  // A few students only come on some days.
  days: i % 9 === 0 ? ["mon", "wed", "fri"] : i % 11 === 0 ? ["tue", "thu"] : ALL_DAYS,
  notes: i % 13 === 0 ? "Booster seat" : "",
}));

// Daily changes, normally entered by staff (or parsed from messages by the LLM).
// type: "student_absent" | "driver_off" | "dismissal_change" | "extra_pickup"
export const exceptions = [];
