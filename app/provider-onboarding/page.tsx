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
  insurance_verification_status: string;
  agreement_accepted: boolean;
  agreement_accepted_at: string | null;
  agreement_version: string | null;
  approval_status: string;
  service_zip_codes: string[];
  membership_tier: string;
  business_registration_status: string;
  local_business_license_status: string;
  ase_certification_status: string;
  epa_609_certification_status: string;
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
  const [serviceZipCodes, setServiceZipCodes] = useState("");

  const [businessRegistrationStatus, setBusinessRegistrationStatus] =
    useState("not_provided");
  const [localBusinessLicenseStatus, setLocalBusinessLicenseStatus] =
    useState("not_provided");
  const [aseCertificationStatus, setAseCertificationStatus] =
    useState("not_provided");
  const [epa609CertificationStatus, setEpa609CertificationStatus] =
    useState("not_provided");

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
      router.push("/auth/login");
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

    const { data, error } = await supabase.rpc("get_my_provider_profile");

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    const existingProfile =
      data && data.length > 0 ? (data[0] as ProviderProfile) : null;

    setProfile(existingProfile);

    if (existingProfile) {
      setBusinessName(existingProfile.business_name ?? "");
      setYearsExperience(existingProfile.years_experience?.toString() ?? "");
      setCertifications(existingProfile.certifications ?? "");
      setServiceZipCodes((existingProfile.service_zip_codes ?? []).join(", "));
      setBusinessRegistrationStatus(
        existingProfile.business_registration_status ?? "not_provided",
      );
      setLocalBusinessLicenseStatus(
        existingProfile.local_business_license_status ?? "not_provided",
      );
      setAseCertificationStatus(
        existingProfile.ase_certification_status ?? "not_provided",
      );
      setEpa609CertificationStatus(
        existingProfile.epa_609_certification_status ?? "not_provided",
      );
      setInsuranceCompany(existingProfile.insurance_company ?? "");
      setInsurancePolicyNumber(existingProfile.insurance_policy_number ?? "");
      setInsuranceExpirationDate(
        existingProfile.insurance_expiration_date ?? "",
      );
      setAgreementAccepted(existingProfile.agreement_accepted);
    }

    setLoading(false);
  }
  async function saveProfile() {
    setMessage("");

    const parsedYears =
      yearsExperience.trim() === "" ? null : Number(yearsExperience);

    if (
      parsedYears !== null &&
      (!Number.isInteger(parsedYears) || parsedYears < 0)
    ) {
      setMessage("Years of experience must be a whole number of 0 or more.");
      return;
    }

    const zipCodes = serviceZipCodes
      .split(/[,\s]+/)
      .map((zip) => zip.trim())
      .filter(Boolean);

    if (zipCodes.some((zip) => !/^\d{5}$/.test(zip))) {
      setMessage(
        "Service ZIP codes must be 5 digits. Separate multiple ZIP codes with commas or spaces.",
      );
      return;
    }

    const uniqueZipCodes = [...new Set(zipCodes)];

    if (!profile && !agreementAccepted) {
      setMessage("You must accept the Provider Services Agreement.");
      return;
    }

    setSaving(true);

    try {
      if (profile) {
        const { error } = await supabase.rpc("update_provider_profile", {
          business_name_input: businessName.trim() || null,
          years_experience_input: parsedYears,
          certifications_input: certifications.trim() || null,
          insurance_company_input: insuranceCompany.trim() || null,
          insurance_policy_number_input: insurancePolicyNumber.trim() || null,
          insurance_expiration_date_input: insuranceExpirationDate || null,
          service_zip_codes_input: uniqueZipCodes,
          business_registration_status_input: businessRegistrationStatus,
          local_business_license_status_input: localBusinessLicenseStatus,
          ase_certification_status_input: aseCertificationStatus,
          epa_609_certification_status_input: epa609CertificationStatus,
        });

        if (error) {
          throw error;
        }

        setMessage("Provider profile updated.");
      } else {
        const { error } = await supabase.rpc("create_provider_profile", {
          business_name_input: businessName.trim() || null,
          years_experience_input: parsedYears,
          certifications_input: certifications.trim() || null,
          insurance_company_input: insuranceCompany.trim() || null,
          insurance_policy_number_input: insurancePolicyNumber.trim() || null,
          insurance_expiration_date_input: insuranceExpirationDate || null,
          agreement_version_input: "1.0",
          service_zip_codes_input: uniqueZipCodes,
          business_registration_status_input: businessRegistrationStatus,
          local_business_license_status_input: localBusinessLicenseStatus,
          ase_certification_status_input: aseCertificationStatus,
          epa_609_certification_status_input: epa609CertificationStatus,
        });

        if (error) {
          throw error;
        }

        setMessage("Provider profile created.");
      }

      await loadProfile();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to save profile.",
      );
    } finally {
      setSaving(false);
    }
  }

  function formatStatus(value: string | null | undefined) {
    if (!value) return "Not provided";

    return value
      .replaceAll("_", " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <p>Loading provider profile...</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-2 text-3xl font-bold">Provider Profile</h1>

      <p className="mb-6 text-gray-600">
        Complete your provider profile, service area, and credentials.
        Credentials may be displayed to customers after verification.
      </p>

      {message && <div className="mb-6 rounded border p-3">{message}</div>}

      {profile && (
        <section className="mb-8 rounded-lg border p-5">
          <h2 className="mb-4 text-xl font-semibold">Account Status</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <p>
              <strong>Provider Type:</strong>{" "}
              {formatStatus(profile.provider_type)}
            </p>

            <p>
              <strong>Membership:</strong>{" "}
              {formatStatus(profile.membership_tier || "silver")}
            </p>

            <p>
              <strong>Approval Status:</strong>{" "}
              {formatStatus(profile.approval_status)}
            </p>

            <p>
              <strong>Background Check:</strong>{" "}
              {formatStatus(profile.background_check_status)}
            </p>

            <p>
              <strong>Insurance Credential:</strong>{" "}
              {formatStatus(profile.insurance_verification_status)}
            </p>
          </div>

          <p className="mt-4 text-sm text-gray-600">
            Membership level is managed separately and cannot be changed from
            this profile form.
          </p>
        </section>
      )}

      <section className="space-y-6 rounded-lg border p-5">
        <div>
          <h2 className="text-xl font-semibold">Business Information</h2>
          <p className="mt-1 text-sm text-gray-600">
            Tell customers about your experience and the business name you
            operate under, if applicable.
          </p>
        </div>
        <div>
          <label className="mb-1 block font-medium" htmlFor="businessName">
            Business Name
          </label>
          <input
            id="businessName"
            className="w-full rounded border p-2"
            value={businessName}
            onChange={(event) => setBusinessName(event.target.value)}
            placeholder="Optional"
          />
        </div>
        <div>
          <label className="mb-1 block font-medium" htmlFor="yearsExperience">
            Years of Experience
          </label>
          <input
            id="yearsExperience"
            type="number"
            min="0"
            step="1"
            className="w-full rounded border p-2"
            value={yearsExperience}
            onChange={(event) => setYearsExperience(event.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block font-medium" htmlFor="certifications">
            Qualifications, Skills, and Certifications
          </label>
          <textarea
            id="certifications"
            className="min-h-28 w-full rounded border p-2"
            value={certifications}
            onChange={(event) => setCertifications(event.target.value)}
            placeholder="Describe relevant training, specialties, certifications, and experience."
          />
        </div>
        <div>
          <label className="mb-1 block font-medium" htmlFor="serviceZipCodes">
            Service ZIP Codes
          </label>
          <input
            id="serviceZipCodes"
            className="w-full rounded border p-2"
            value={serviceZipCodes}
            onChange={(event) => setServiceZipCodes(event.target.value)}
            placeholder="30294, 30273, 30349"
          />
          <p className="mt-1 text-sm text-gray-600">
            Enter each 5-digit ZIP code where you provide mobile service.
            Separate ZIP codes with commas or spaces.
          </p>
        </div>{" "}
        <div className="border-t pt-6">
          <h2 className="text-xl font-semibold">Business Credentials</h2>
          <p className="mt-1 text-sm text-gray-600">
            Indicate credentials or registrations that apply to your business.
            Providing a credential does not mean it has been verified by the
            marketplace.
          </p>
        </div>
        <div>
          <label
            className="mb-1 block font-medium"
            htmlFor="businessRegistrationStatus"
          >
            Georgia Business Registration
          </label>
          <select
            id="businessRegistrationStatus"
            className="w-full rounded border p-2"
            value={businessRegistrationStatus}
            onChange={(event) =>
              setBusinessRegistrationStatus(event.target.value)
            }
          >
            <option value="not_provided">Not provided</option>
            <option value="provided">I have a business registration</option>
            <option value="not_applicable">
              Not applicable to my business
            </option>
          </select>
        </div>
        <div>
          <label
            className="mb-1 block font-medium"
            htmlFor="localBusinessLicenseStatus"
          >
            Local Business License / Occupational Tax Certificate
          </label>
          <select
            id="localBusinessLicenseStatus"
            className="w-full rounded border p-2"
            value={localBusinessLicenseStatus}
            onChange={(event) =>
              setLocalBusinessLicenseStatus(event.target.value)
            }
          >
            <option value="not_provided">Not provided</option>
            <option value="provided">I have this credential</option>
            <option value="not_applicable">
              Not applicable to my business
            </option>
          </select>
        </div>
        <div className="border-t pt-6">
          <h2 className="text-xl font-semibold">Professional Certifications</h2>
          <p className="mt-1 text-sm text-gray-600">
            These credentials can help customers understand your qualifications.
            Only claim credentials you currently hold.
          </p>
        </div>
        <div>
          <label
            className="mb-1 block font-medium"
            htmlFor="aseCertificationStatus"
          >
            ASE Certification
          </label>
          <select
            id="aseCertificationStatus"
            className="w-full rounded border p-2"
            value={aseCertificationStatus}
            onChange={(event) => setAseCertificationStatus(event.target.value)}
          >
            <option value="not_provided">Not provided</option>
            <option value="provided">I have ASE certification</option>
          </select>
        </div>
        <div>
          <label
            className="mb-1 block font-medium"
            htmlFor="epa609CertificationStatus"
          >
            EPA Section 609 Certification
          </label>
          <select
            id="epa609CertificationStatus"
            className="w-full rounded border p-2"
            value={epa609CertificationStatus}
            onChange={(event) =>
              setEpa609CertificationStatus(event.target.value)
            }
          >
            <option value="not_provided">Not provided</option>
            <option value="provided">
              I have EPA Section 609 certification
            </option>
          </select>
          <p className="mt-1 text-sm text-gray-600">
            Relevant for providers who service motor-vehicle air conditioning
            systems involving regulated refrigerants.
          </p>
        </div>
        <div className="border-t pt-6">
          <h2 className="text-xl font-semibold">
            Optional Insurance Information
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Insurance is not presented here as a universal provider requirement.
            If you provide insurance information, it may be reviewed separately
            before being shown as verified.
          </p>
        </div>
        <div>
          <label className="mb-1 block font-medium" htmlFor="insuranceCompany">
            Insurance Company
          </label>
          <input
            id="insuranceCompany"
            className="w-full rounded border p-2"
            value={insuranceCompany}
            onChange={(event) => setInsuranceCompany(event.target.value)}
            placeholder="Optional"
          />
        </div>
        <div>
          <label
            className="mb-1 block font-medium"
            htmlFor="insurancePolicyNumber"
          >
            Policy Number
          </label>
          <input
            id="insurancePolicyNumber"
            className="w-full rounded border p-2"
            value={insurancePolicyNumber}
            onChange={(event) => setInsurancePolicyNumber(event.target.value)}
            placeholder="Optional"
          />
        </div>
        <div>
          <label
            className="mb-1 block font-medium"
            htmlFor="insuranceExpirationDate"
          >
            Insurance Expiration Date
          </label>
          <input
            id="insuranceExpirationDate"
            type="date"
            className="w-full rounded border p-2"
            value={insuranceExpirationDate}
            onChange={(event) => setInsuranceExpirationDate(event.target.value)}
          />
        </div>{" "}
        {!profile && (
          <div className="border-t pt-6">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={agreementAccepted}
                onChange={(event) => setAgreementAccepted(event.target.checked)}
              />
              <span>
                I accept the Provider Services Agreement, including marketplace
                rules, independent provider responsibilities, credential
                accuracy, applicable licensing and certification requirements,
                and off-platform payment restrictions.
              </span>
            </label>
          </div>
        )}
        {profile?.agreement_accepted && (
          <div className="border-t pt-6 text-sm text-gray-600">
            Provider Services Agreement accepted
            {profile.agreement_version
              ? ` — version ${profile.agreement_version}`
              : ""}
            .
          </div>
        )}
        <div className="border-t pt-6">
          <button
            type="button"
            onClick={saveProfile}
            disabled={saving}
            className="rounded bg-black px-5 py-2 font-medium text-white disabled:opacity-50"
          >
            {saving
              ? "Saving..."
              : profile
                ? "Update Provider Profile"
                : "Create Provider Profile"}
          </button>
        </div>
      </section>
    </main>
  );
}
