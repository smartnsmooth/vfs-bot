export interface Slot {
  id: string;           // Unique slot identifier
  center: string;       // Visa center name or code
  date: string;         // YYYY-MM-DD
  time: string;         // HH:MM format
  rawDate?: string;     // Original earliestSlotLists date string (e.g. MM/DD/YYYY ...)
  serviceType?: string; // Optional: type of visa/service (e.g., tourist, business)
  status?: string;      // Optional: available, booked, hold, etc.
}

/** Response from lift-api CheckIsSlotAvailable */
export interface CheckIsSlotAvailableResponse {
  earliestDate: string | null;
  earliestSlotLists: Array<{ applicant: string; date: string }>;
  error: { code: number; description: string; type: string } | null;
}