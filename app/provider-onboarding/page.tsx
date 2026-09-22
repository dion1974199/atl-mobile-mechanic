"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type ProviderProfile = {
  id: string;
  provider_type: string;
  business_name: string | null;
  years_experience: number | null;
  certifications: string | null;
  insurance_company: string | null;
  insurance_policy_number: string | null;
  insurance_expiration_date: string | null;
  background_check_status: string;
  insurance_status: string;
  agreement_accepted: boolean;
  agreement_accepted_at: string | null;
  agreement_version: string | null;
  approval_status: string;
};

export default function ProviderOnboardingPage() {
  const supabase = createClient();
  const router = useRouter();

  const [profile, setProfile] = useState<ProviderProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const [businessName, setBusinessName] = useState("");
  const [yearsExperience, setYearsExperience] = useState("");
  const [certifications, setCertifications] = useState("");
  const [insuranceCompany, setInsuranceCompany] = useState("");
  const [insurancePolicyNumber, setInsurancePolicyNumber] = useState("");
  const [insuranceExpirationDate, setInsuranceExpirationDate] = useState("");
  const [agreementAccepted, setAgreementAccepted] = useState(false);

  useEffect(() => {
    loadProfile();
  }, []);

  async function loadProfile() {
    setLoading(true);
    

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      router.push("/login");
      return;
    }

    const { data: roleProfile, error: roleError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (roleError) {
      setMessage(roleError.message);
      setLoading(false);
      return;
    }

    if (
      roleProfile.role !== "mechanic" &&
      roleProfile.role !== "tire_technician"
    ) {
      router.push("/requests");
      return;
    }

    const { data, error } = await supabase.rpc(
      "get_my_provider_profile"
    );

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    const existingProfile =
      data && data.length > 0
        ? (data[0] as ProviderProfile)
        : null;

    setProfile(existingProfile);

    if (existingProfile) {
      setBusinessName(existingProfile.business_name ?? "");
      setYearsExperience(
        existingProfile.years_experience?.toString() ?? ""
      );
      setCertifications(existingProfile.certifications ?? "");
      setInsuranceCompany(existingProfile.insurance_company ?? "");
      setInsurancePolicyNumber(
        existingProfile.insurance_policy_number ?? ""
      );
      setInsuranceExpirationDate(
        existingProfile.insurance_expiration_date ?? ""
      );
      setAgreementAccepted(existingProfile.agreement_accepted);
    }

    setLoading(false);
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage("");

    const years =
      yearsExperience.trim() === ""
        ? null
        : Number(yearsExperience);

    if (
      years !== null &&
      (!Number.isInteger(years) || years < 0)
    ) {
      setMessage("Years of experience must be 0 or greater.");
      setSaving(false);
      return;
    }

    if (!profile && !agreementAccepted) {
      setMessage(
        "You must accept the Provider Services Agreement."
      );
      setSaving(false);
      return;
    }

    if (profile) {
      const { error } = await supabase.rpc(
        "update_provider_profile",
        {
          business_name_input: businessName,
          years_experience_input: years,
          certifications_input: certifications,
          insurance_company_input: insuranceCompany,
          insurance_policy_number_input: insurancePolicyNumber,
          insurance_expiration_date_input:
            insuranceExpirationDate || null,
        }
      );

      if (error) {
        setMessage(error.message);
        setSaving(false);
        return;
      }

      setMessage("Provider profile updated.");
    } else {
      const { error } = await supabase.rpc(
        "create_provider_profile",
        {
          business_name_input: businessName,
          years_experience_input: years,
          certifications_input: certifications,
          insurance_company_input: insuranceCompany,
          insurance_policy_number_input: insurancePolicyNumber,
          insurance_expiration_date_input:
            insuranceExpirationDate || null,
          agreement_version_input: "1.0",
        }
      );

      if (error) {
        setMessage(error.message);
        setSaving(false);
        return;
      }

      setMessage("Provider application submitted.");
    }

    await loadProfile();
    setSaving(false);
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-100 p-6 text-gray-900">
        Loading...
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-100 p-6 text-gray-900">
      <div className="mx-auto max-w-2xl rounded-lg bg-white p-6 shadow">
        <h1 className="text-3xl font-bold text-gray-900">
          Provider Onboarding
        </h1>

        <p className="mt-2 text-gray-600">
          Complete your provider information for review and approval.
        </p>

        {message && (
          <div className="mt-4 rounded border border-gray-300 bg-gray-50 p-3">
            {message}
          </div>
        )}

        {profile && (
          <div className="mt-6 rounded border p-4">
            <p>
              <strong>Provider Type:</strong>{" "}
              {profile.provider_type === "tire_technician"
                ? "Tire Technician"
                : "Mechanic"}
            </p>

            <p>
              <strong>Approval Status:</strong>{" "}
              {profile.approval_status}
            </p>

            <p>
              <strong>Background Check:</strong>{" "}
              {profile.background_check_status}
            </p>

            <p>
              <strong>Insurance Status:</strong>{" "}
              {profile.insurance_status}
            </p>
          </div>
        )}

        <form onSubmit={saveProfile} className="mt-6 space-y-4">
          <div>
            <label className="block font-semibold">
              Business Name
            </label>
            <input
              type="text"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              className="mt-1 w-full rounded border p-2"
            />
          </div>

          <div>
            <label className="block font-semibold">
              Years of Experience
            </label>
            <input
              type="number"
              min="0"
              value={yearsExperience}
              onChange={(e) => setYearsExperience(e.target.value)}
              className="mt-1 w-full rounded border p-2"
            />
          </div>

          <div>
            <label className="block font-semibold">
              Certifications / Qualifications
            </label>
            <textarea
              value={certifications}
              onChange={(e) => setCertifications(e.target.value)}
              className="mt-1 w-full rounded border p-2"
              rows={3}
            />
          </div>

          <div>
            <label className="block font-semibold">
              Insurance Company
            </label>
            <input
              type="text"
              value={insuranceCompany}
              onChange={(e) => setInsuranceCompany(e.target.value)}
              className="mt-1 w-full rounded border p-2"
            />
          </div>

          <div>
            <label className="block font-semibold">
              Insurance Policy Number
            </label>
            <input
              type="text"
              value={insurancePolicyNumber}
              onChange={(e) =>
                setInsurancePolicyNumber(e.target.value)
              }
              className="mt-1 w-full rounded border p-2"
            />
          </div>

          <div>
            <label className="block font-semibold">
              Insurance Expiration Date
            </label>
            <input
              type="date"
              value={insuranceExpirationDate}
              onChange={(e) =>
                setInsuranceExpirationDate(e.target.value)
              }
              className="mt-1 w-full rounded border p-2"
            />
          </div>

          {!profile && (
            <div className="rounded border p-4">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={agreementAccepted}
                  onChange={(e) =>
                    setAgreementAccepted(e.target.checked)
                  }
                  className="mt-1"
                />

                <span>
                  I accept the Provider Services Agreement,
                  including marketplace rules, independent provider
                  responsibilities, insurance requirements, and
                  off-platform payment restrictions.
                </span>
              </label>
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="rounded bg-black px-5 py-2 font-semibold text-white disabled:opacity-50"
          >
            {saving
              ? "Saving..."
              : profile
              ? "Update Provider Profile"
              : "Submit Provider Application"}
          </button>
        </form>
      </div>
    </main>
  );
}