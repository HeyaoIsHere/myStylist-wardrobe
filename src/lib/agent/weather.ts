import type { WeatherProvider, WeatherReport } from "./types";

/**
 * Weather provider seam (Phase 6 tool `get_weather`).
 *
 * Local development / evaluation uses the deterministic mock below — no real
 * weather API is configured by default, and that is a DOCUMENTED limitation,
 * not a failure: the agent only consults weather when the request actually
 * warrants it, and a real provider (e.g. Open-Meteo / OpenWeatherMap) is a
 * swap of this interface, never a change to the agent.
 */

/**
 * Deterministic mock weather report — the same value every call, so evaluation
 * and offline development are reproducible. `condition`/`temperatureC` are
 * configurable so tests can force a cold/rainy day.
 */
export class MockWeatherProvider implements WeatherProvider {
  readonly name = "mock-weather";
  private readonly report: WeatherReport;

  constructor(report: Partial<WeatherReport> = {}) {
    this.report = {
      location: report.location ?? "local",
      condition: report.condition ?? "clear",
      temperatureC: report.temperatureC ?? 18,
      humidityPct: report.humidityPct,
      source: "mock-weather-v1",
    };
  }

  async getWeather(location?: string): Promise<WeatherReport> {
    // A 1 ms pseudo-delay so timings are visible but tests stay fast.
    await new Promise((r) => setTimeout(r, 1));
    return { ...this.report, location: location?.trim() || this.report.location };
  }
}

/**
 * A provider that always fails — exercises the "required tool/provider is
 * unavailable" termination path deterministically.
 */
export class ThrowingWeatherProvider implements WeatherProvider {
  readonly name = "throwing-weather";
  async getWeather(): Promise<WeatherReport> {
    throw new Error("weather service unavailable");
  }
}

const WEATHER_BY_TEMP: Array<[number, string]> = [
  [-Infinity, "cold"],
  [6, "cool"],
  [14, "mild"],
  [21, "warm"],
  [28, "hot"],
];

/** A one-token weather-level (soft signal) from a report — never a hard filter. */
export function weatherLevel(report: WeatherReport): string {
  for (const [threshold, level] of WEATHER_BY_TEMP) {
    if (report.temperatureC >= threshold) return level;
  }
  return "mild";
}

/** Short, bounded SOFT description appended to the semantic query text. */
export function weatherDescriptor(report: WeatherReport | null): string {
  if (!report) return "";
  const level = weatherLevel(report);
  return `current-weather ${report.condition} ${level}`;
}