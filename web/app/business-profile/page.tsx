"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { API_BASE, fetchBusinessProfile, resetBusinessProfile, updateBusinessProfile } from "@/app/lib/api";
import type { BusinessProfile, MenuItemProfile } from "@/app/lib/types";

const CUSTOM_PROFILE_OPTION = "__custom__";

const BUSINESS_TYPE_OPTIONS = ["Fast Food", "Fast Casual", "Casual Dining", "Coffee Shop / Cafe", "Ghost Kitchen"];

const SERVICE_MODEL_OPTIONS = [
  "Drive-thru + Counter",
  "Drive-thru Only",
  "Counter / Walk-in Only",
  "Dine-in + Counter",
  "Pickup + Delivery",
];

function normalizeMenuItem(item: MenuItemProfile): MenuItemProfile {
  const legacyItem = item as MenuItemProfile & { max_batch_size?: number };
  const maxUnitSize = Math.max(1, Math.min(5000, Math.round(item.max_unit_size ?? legacyItem.max_batch_size ?? 64)));
  const batchSize = Math.max(1, Math.min(Math.round(item.batch_size), maxUnitSize));
  return { ...item, batch_size: batchSize, max_unit_size: maxUnitSize };
}

function normalizeProfile(profile: BusinessProfile): BusinessProfile {
  return {
    ...profile,
    menu_items: profile.menu_items.map(normalizeMenuItem),
  };
}

function menuTemplate(): MenuItemProfile {
  return {
    label: "New Menu Item",
    units_per_order: 0.3,
    batch_size: 6,
    max_unit_size: 24,
    baseline_drop_units: 6,
    unit_cost_usd: 0.5,
  };
}

export default function BusinessProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<BusinessProfile | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileStatus, setProfileStatus] = useState<string | null>(null);

  const hasUnsavedChanges = useMemo(() => {
    if (!profile || !profileDraft) {
      return false;
    }
    return JSON.stringify(profile) !== JSON.stringify(profileDraft);
  }, [profile, profileDraft]);
  const isBusinessTypeCustom = useMemo(
    () => (profileDraft ? !BUSINESS_TYPE_OPTIONS.includes(profileDraft.business_type) : false),
    [profileDraft],
  );
  const isServiceModelCustom = useMemo(
    () => (profileDraft ? !SERVICE_MODEL_OPTIONS.includes(profileDraft.service_model) : false),
    [profileDraft],
  );

  useEffect(() => {
    let alive = true;

    const loadProfile = async () => {
      try {
        const data = await fetchBusinessProfile();
        if (!alive) {
          return;
        }
        const normalized = normalizeProfile(data);
        setProfile(normalized);
        setProfileDraft(normalized);
      } catch (err) {
        if (!alive) {
          return;
        }
        setProfileError(err instanceof Error ? err.message : "Could not load business profile.");
      }
    };

    void loadProfile();

    return () => {
      alive = false;
    };
  }, []);

  const onProfileTextChange = (
    field: "business_name" | "business_type" | "location" | "service_model",
    value: string,
  ) => {
    setProfileDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  const onProfileNumberChange = (field: "avg_ticket_usd", value: string) => {
    const parsed = Number(value);
    const numericValue = Number.isFinite(parsed) ? parsed : 0;
    setProfileDraft((prev) => (prev ? { ...prev, [field]: numericValue } : prev));
  };

  const onMenuTextChange = (index: number, field: "label", value: string) => {
    setProfileDraft((prev) => {
      if (!prev) {
        return prev;
      }
      const nextItems = prev.menu_items.map((item, itemIndex) => (itemIndex === index ? { ...item, [field]: value } : item));
      return { ...prev, menu_items: nextItems };
    });
  };

  const onMenuNumberChange = (
    index: number,
    field: "units_per_order" | "batch_size" | "max_unit_size" | "baseline_drop_units" | "unit_cost_usd",
    value: string,
  ) => {
    const parsed = Number(value);
    setProfileDraft((prev) => {
      if (!prev) {
        return prev;
      }

      const nextItems = prev.menu_items.map((item, itemIndex) => {
        if (itemIndex !== index) {
          return item;
        }

        let numericValue = Number.isFinite(parsed) ? parsed : 0;
        if (field === "max_unit_size") {
          const nextMaxUnitSize = Math.max(1, Math.min(5000, Math.round(numericValue)));
          return normalizeMenuItem({
            ...item,
            max_unit_size: nextMaxUnitSize,
            batch_size: Math.min(item.batch_size, nextMaxUnitSize),
          });
        }

        if (field === "batch_size") {
          numericValue = Math.min(Math.max(1, Math.round(numericValue)), item.max_unit_size);
        }

        return { ...item, [field]: numericValue };
      });
      return { ...prev, menu_items: nextItems };
    });
  };

  const addMenuItem = () => {
    setProfileDraft((prev) => {
      if (!prev) {
        return prev;
      }
      return { ...prev, menu_items: [...prev.menu_items, menuTemplate()] };
    });
  };

  const removeMenuItem = (index: number) => {
    setProfileDraft((prev) => {
      if (!prev || prev.menu_items.length <= 1) {
        return prev;
      }
      return { ...prev, menu_items: prev.menu_items.filter((_, itemIndex) => itemIndex !== index) };
    });
  };

  useEffect(() => {
    if (!hasUnsavedChanges) {
      return;
    }

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) {
        return;
      }
      const currentPath = window.location.pathname;
      const nextUrl = new URL(href, window.location.origin);
      if (nextUrl.pathname === currentPath) {
        return;
      }
      const leave = window.confirm("You have unsaved changes. Leave this page?");
      if (!leave) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onDocumentClick, true);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onDocumentClick, true);
    };
  }, [hasUnsavedChanges]);

  const saveProfile = async (redirectTo?: string) => {
    if (!profileDraft) {
      return;
    }

    setProfileBusy(true);
    setProfileError(null);
    setProfileStatus(null);

    try {
      const saved = await updateBusinessProfile(profileDraft);
      const normalized = normalizeProfile(saved);
      setProfile(normalized);
      setProfileDraft(normalized);
      setProfileStatus("Business profile saved. Recommendations now use your menu.");
      if (redirectTo) {
        router.push(redirectTo);
      }
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Unable to save business profile.");
    } finally {
      setProfileBusy(false);
    }
  };

  const onSubmitProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await saveProfile();
  };

  const loadSampleBusiness = async () => {
    setProfileBusy(true);
    setProfileError(null);
    setProfileStatus(null);

    try {
      const sample = await resetBusinessProfile();
      const normalized = normalizeProfile(sample);
      setProfile(normalized);
      setProfileDraft(normalized);
      setProfileStatus("Sample business profile loaded.");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Unable to load sample business.");
    } finally {
      setProfileBusy(false);
    }
  };

  return (
    <main className="mx-auto grid w-[min(1280px,calc(100%-24px))] gap-4 py-4 md:w-[min(1280px,calc(100%-36px))] md:py-6">
      <section className="panel rounded-3xl p-5 md:p-6">
        <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="display text-2xl font-semibold tracking-tight text-graphite md:text-3xl">Business Profile & Menu</h1>
            <p className="text-sm text-muted md:text-base">
              Configure your business identity and menu inputs. Recommendation outputs update from this profile.
            </p>
          </div>
          <div className="text-xs text-muted">Backend: {API_BASE}</div>
        </div>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Profile Editor</p>
          <button
            type="button"
            disabled={profileBusy}
            onClick={() => void loadSampleBusiness()}
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Load Sample Business
          </button>
        </div>

        {profileDraft ? (
          <form onSubmit={onSubmitProfile} className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <label className="text-sm text-slate-700">
                <span className="mb-1 block text-xs font-bold uppercase tracking-[0.12em] text-muted">Business Name</span>
                <input
                  value={profileDraft.business_name}
                  onChange={(event) => onProfileTextChange("business_name", event.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                />
              </label>
              <label className="text-sm text-slate-700">
                <span className="mb-1 block text-xs font-bold uppercase tracking-[0.12em] text-muted">Business Type</span>
                <select
                  value={isBusinessTypeCustom ? CUSTOM_PROFILE_OPTION : profileDraft.business_type}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    if (nextValue === CUSTOM_PROFILE_OPTION) {
                      if (!isBusinessTypeCustom) {
                        onProfileTextChange("business_type", "");
                      }
                      return;
                    }
                    onProfileTextChange("business_type", nextValue);
                  }}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                >
                  {BUSINESS_TYPE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                  <option value={CUSTOM_PROFILE_OPTION}>Other (Custom)</option>
                </select>
                {isBusinessTypeCustom ? (
                  <input
                    value={profileDraft.business_type}
                    onChange={(event) => onProfileTextChange("business_type", event.target.value)}
                    placeholder="Enter custom business type"
                    className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                  />
                ) : null}
              </label>
              <label className="text-sm text-slate-700">
                <span className="mb-1 block text-xs font-bold uppercase tracking-[0.12em] text-muted">Location</span>
                <input
                  value={profileDraft.location}
                  onChange={(event) => onProfileTextChange("location", event.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                />
              </label>
              <label className="text-sm text-slate-700">
                <span className="mb-1 block text-xs font-bold uppercase tracking-[0.12em] text-muted">Service Model</span>
                <select
                  value={isServiceModelCustom ? CUSTOM_PROFILE_OPTION : profileDraft.service_model}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    if (nextValue === CUSTOM_PROFILE_OPTION) {
                      if (!isServiceModelCustom) {
                        onProfileTextChange("service_model", "");
                      }
                      return;
                    }
                    onProfileTextChange("service_model", nextValue);
                  }}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                >
                  {SERVICE_MODEL_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                  <option value={CUSTOM_PROFILE_OPTION}>Other (Custom)</option>
                </select>
                {isServiceModelCustom ? (
                  <input
                    value={profileDraft.service_model}
                    onChange={(event) => onProfileTextChange("service_model", event.target.value)}
                    placeholder="Enter custom service model"
                    className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                  />
                ) : null}
              </label>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm text-slate-700">
                <span className="mb-1 block text-xs font-bold uppercase tracking-[0.12em] text-muted">Average Ticket ($)</span>
                <input
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={profileDraft.avg_ticket_usd}
                  onChange={(event) => onProfileNumberChange("avg_ticket_usd", event.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                />
              </label>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Menu Items</p>
                <button
                  type="button"
                  onClick={addMenuItem}
                  className="rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-700"
                >
                  Add Item
                </button>
              </div>

              {profileDraft.menu_items.map((item, index) => (
                <article key={item.key ?? `${item.label}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="display text-sm font-semibold text-graphite">Item {index + 1}</p>
                    <button
                      type="button"
                      disabled={profileDraft.menu_items.length <= 1}
                      onClick={() => removeMenuItem(index)}
                      className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Remove
                    </button>
                  </div>

                  <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                    <label className="text-xs text-slate-700">
                      <span className="mb-1 block font-semibold uppercase tracking-[0.08em] text-muted">Label</span>
                      <input
                        value={item.label}
                        onChange={(event) => onMenuTextChange(index, "label", event.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                      />
                    </label>
                    <label className="text-xs text-slate-700">
                      <span className="mb-1 block font-semibold uppercase tracking-[0.08em] text-muted">Units / Order</span>
                      <input
                        type="number"
                        min={0.01}
                        step={0.01}
                        value={item.units_per_order}
                        onChange={(event) => onMenuNumberChange(index, "units_per_order", event.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                      />
                    </label>
                    <label className="text-xs text-slate-700">
                      <span className="mb-1 block font-semibold uppercase tracking-[0.08em] text-muted">Batch Size</span>
                      <input
                        type="number"
                        min={1}
                        max={item.max_unit_size}
                        step={1}
                        value={item.batch_size}
                        onChange={(event) => onMenuNumberChange(index, "batch_size", event.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                      />
                    </label>
                    <label className="text-xs text-slate-700">
                      <span className="mb-1 block font-semibold uppercase tracking-[0.08em] text-muted">Max Unit Size</span>
                      <input
                        type="number"
                        min={1}
                        max={5000}
                        step={1}
                        value={item.max_unit_size}
                        onChange={(event) => onMenuNumberChange(index, "max_unit_size", event.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                      />
                    </label>
                    <label className="text-xs text-slate-700">
                      <span className="mb-1 block font-semibold uppercase tracking-[0.08em] text-muted">Baseline Units</span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={item.baseline_drop_units}
                        onChange={(event) => onMenuNumberChange(index, "baseline_drop_units", event.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                      />
                    </label>
                    <label className="text-xs text-slate-700">
                      <span className="mb-1 block font-semibold uppercase tracking-[0.08em] text-muted">Unit Cost ($)</span>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={item.unit_cost_usd}
                        onChange={(event) => onMenuNumberChange(index, "unit_cost_usd", event.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
                      />
                    </label>
                  </div>
                </article>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={profileBusy}
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {profileBusy ? "Saving..." : "Save Business Profile"}
              </button>
              <button
                type="button"
                disabled={profileBusy}
                onClick={() => void saveProfile("/")}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Save & Go to Live View
              </button>
              {profile ? (
                <span className="text-xs text-muted">
                  Last loaded: {profile.business_name} ({profile.menu_items.length} items)
                </span>
              ) : null}
            </div>

            {hasUnsavedChanges ? <p className="text-xs text-amber-700">You have unsaved changes.</p> : null}

            {profileStatus ? <p className="text-xs text-emerald-700">{profileStatus}</p> : null}
            {profileError ? <p className="text-xs text-red-600">{profileError}</p> : null}
          </form>
        ) : (
          <p className="text-sm text-muted">Loading business profile...</p>
        )}
      </section>
    </main>
  );
}
