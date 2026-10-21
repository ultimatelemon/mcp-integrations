import { z } from 'zod';

export const station = (what: string) =>
  z
    .string()
    .min(1)
    .describe(
      `${what}: station name (e.g. "Utrecht", "Den Bosch"), NS code (e.g. "UT") or UIC code`
    );

export const dateTime = z
  .string()
  .optional()
  .describe(
    'ISO 8601 date/time, e.g. "2026-10-06T18:30". Without an offset it is read as Amsterdam time. Defaults to now.'
  );

export const trainNumber = z
  .number()
  .int()
  .positive()
  .describe('Train number (ritnummer), e.g. 3529');

export const place = {
  locatie: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Address, station or place, e.g. "Damrak 1 Amsterdam", "station Almere Muziekwijk", "Buiksloterweg"'
    ),
  lat: z
    .number()
    .min(50)
    .max(54)
    .optional()
    .describe('Latitude, instead of locatie'),
  lon: z
    .number()
    .min(3)
    .max(8)
    .optional()
    .describe('Longitude, instead of locatie')
};

export const operator = z
  .string()
  .min(1)
  .default('check')
  .describe(
    'Operator as the Dashboard Deelmobiliteit names it: check, felyx, gosharing, …'
  );
