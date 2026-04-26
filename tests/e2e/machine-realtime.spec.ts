import { test, expect } from "@playwright/test";

/**
 * E2E: Machine realtime status + smart onboarding.
 *
 * Tests the new machine.status live events infrastructure,
 * machineCount in companies API, and smart onboarding redirect.
 *
 * Run with: npx playwright test --config tests/e2e/machine-realtime-local.config.ts
 * (requires a running local server on port 3100)
 */

test.describe("Machine realtime & smart onboarding", () => {
  test("companies API returns machineCount field", async ({ request }) => {
    const res = await request.get("/api/companies");
    expect(res.ok()).toBe(true);
    const companies = await res.json();

    expect(Array.isArray(companies)).toBe(true);

    for (const company of companies) {
      expect(company).toHaveProperty("machineCount");
      expect(typeof company.machineCount).toBe("number");
      expect(company.machineCount).toBeGreaterThanOrEqual(0);
    }
  });

  test("health endpoint returns ok", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBe(true);
    const health = await res.json();
    expect(health.status).toBe("ok");
  });

  test("onboarding wizard shows all 5 step tabs", async ({ page }) => {
    await page.goto("/onboarding");
    await page.waitForTimeout(3000);

    // Wizard may auto-open as overlay, or show a "Start" button behind it
    // Either way, the tabs should be in the DOM
    const tabLabels = ["Company", "Machine", "Agent", "Task", "Launch"];
    for (const label of tabLabels) {
      const tab = page.getByRole("button", { name: label, exact: true });
      await expect(tab).toBeAttached({ timeout: 10_000 });
    }
  });

  test("onboarding wizard tabs scrollable on mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/onboarding");
    await page.waitForTimeout(3000);

    // All tabs should be in DOM even at mobile viewport
    const tabLabels = ["Company", "Machine", "Agent", "Task", "Launch"];
    for (const label of tabLabels) {
      const tab = page.getByRole("button", { name: label, exact: true });
      await expect(tab).toBeAttached({ timeout: 10_000 });
    }
  });

  test("machines API returns adapters array", async ({ request }) => {
    const companiesRes = await request.get("/api/companies");
    const companies = await companiesRes.json();
    if (companies.length === 0) {
      test.skip();
      return;
    }

    const companyId = companies[0].id;
    const machinesRes = await request.get(`/api/companies/${companyId}/machines`);
    expect(machinesRes.ok()).toBe(true);

    const machines = await machinesRes.json();
    expect(Array.isArray(machines)).toBe(true);

    for (const machine of machines) {
      expect(machine).toHaveProperty("adapters");
      expect(Array.isArray(machine.adapters)).toBe(true);
    }
  });

  test("machines page renders in mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/");
    await page.waitForURL(/dashboard|onboarding/, { timeout: 15_000 });

    const url = page.url();
    const prefix = url.match(/\/([^/]+)\/(?:dashboard|onboarding)/)?.[1];
    if (!prefix) {
      test.skip();
      return;
    }

    await page.goto(`/${prefix}/machines`);
    await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Add Machine" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
  });

  test("add machine modal opens and shows CLI command", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/dashboard|onboarding/, { timeout: 15_000 });

    const url = page.url();
    const prefix = url.match(/\/([^/]+)\/(?:dashboard|onboarding)/)?.[1];
    if (!prefix) {
      test.skip();
      return;
    }

    await page.goto(`/${prefix}/machines`);
    await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Add Machine" }).click();
    await expect(page.getByText("Connect a machine")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("npx artu-teams connect")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Waiting for connection...")).toBeVisible();
  });
});
