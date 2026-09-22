"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type ProviderApplication = {
  user_id: string;
  provider_type: string;
  business_name: string | null;
  years_experience: number | null;
  certifications: string | null;
  insurance_company: string | null;
  insurance_expiration_date: string | null;
  background_check_status: string;
  insurance_status: string;
  approval_status: string;
  created_at: string;
};

export default function AdminProvidersPage() {
  const supabase = createClient();

  const [applications, setApplications] = useState<ProviderApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);

  async function loadApplications() {
    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      window.location.href = "/auth/login";
      return;
    }

    const { data, error } = await supabase.rpc(
      "get_all_provider_applications"
    );

    if (error) {
      setMessage(error.message);
      setApplications([]);
      setLoading(false);
      return;
    }

    setApplications((data ?? []) as ProviderApplication[]);
    setLoading(false);
  }

  useEffect(() => {
    loadApplications();
  }, []);

  async function updateProviderStatus(
    userId: string,
    approvalStatus: "approved" | "rejected" | "suspended"
  ) {
    setUpdatingUserId(userId);
    setMessage("");

    let backgroundStatus = "approved";
    let insuranceStatus = "approved";

    if (approvalStatus === "rejected") {
      backgroundStatus = "rejected";
      insuranceStatus = "rejected";
    }

    const { error } = await supabase.rpc(
      "admin_update_provider_status",
      {
        provider_user_id: userId,
        new_approval_status: approvalStatus,
        new_background_check_status: backgroundStatus,
        new_insurance_status: insuranceStatus,
      }
    );

    if (error) {
      setMessage(error.message);
      setUpdatingUserId(null);
      return;
    }

    if (approvalStatus === "approved") {
      setMessage("Provider approved.");
    } else if (approvalStatus === "suspended") {
      setMessage("Provider suspended.");
    } else {
      setMessage("Provider rejected.");
    }

    setUpdatingUserId(null);
    await loadApplications();
  }

  async function updateInsuranceStatus(
    userId: string,
    insuranceStatus: "approved" | "rejected"
  ) {
    setUpdatingUserId(userId);
    setMessage("");

    const { error } = await supabase.rpc(
      "admin_update_provider_insurance_status",
      {
        provider_user_id: userId,
        new_insurance_status: insuranceStatus,
      }
    );

    if (error) {
      setMessage(error.message);
      setUpdatingUserId(null);
      return;
    }

    if (insuranceStatus === "approved") {
      setMessage("Provider insurance approved.");
    } else {
      setMessage("Provider insurance rejected.");
    }

    setUpdatingUserId(null);
    await loadApplications();
  }

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/auth/login";
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-100 p-6">
        <p className="text-gray-900">Loading provider applications...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">
              Admin Provider Review
            </h1>

            <p className="mt-2 text-gray-700">
              Review and manage mechanic and tire technician applications.
            </p>
          </div>

          <button
            onClick={logout}
            className="rounded bg-gray-800 px-4 py-2 font-semibold text-white"
          >
            Logout
          </button>
        </div>

        {message && (
          <div className="mb-6 rounded border border-blue-300 bg-blue-50 p-4 font-semibold text-blue-900">
            {message}
          </div>
        )}

        {applications.length === 0 ? (
          <div className="rounded bg-white p-6 shadow">
            <p className="text-gray-900">No provider applications found.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {applications.map((provider) => (
              <div
                key={provider.user_id}
                className="rounded bg-white p-6 shadow"
              >
                <h2 className="mb-4 text-2xl font-bold text-gray-900">
                  {provider.business_name || "Unnamed Provider"}
                </h2>

                <div className="space-y-2 text-gray-900">
                  <p>
                    <strong>Provider Type:</strong>{" "}
                    {provider.provider_type === "tire_technician"
                      ? "Tire Technician"
                      : "Mechanic"}
                  </p>

                  <p>
                    <strong>Years of Experience:</strong>{" "}
                    {provider.years_experience ?? "Not provided"}
                  </p>

                  <p>
                    <strong>Certifications / Qualifications:</strong>{" "}
                    {provider.certifications || "Not provided"}
                  </p>

                  <p>
                    <strong>Insurance Company:</strong>{" "}
                    {provider.insurance_company || "Not provided"}
                  </p>

                  <p>
                    <strong>Insurance Expiration:</strong>{" "}
                    {provider.insurance_expiration_date || "Not provided"}
                  </p>

                  <p>
                    <strong>Background Check:</strong>{" "}
                    {provider.background_check_status}
                  </p>

                  <p>
                    <strong>Insurance Status:</strong>{" "}
                    {provider.insurance_status}
                  </p>

                  <p>
                    <strong>Approval Status:</strong>{" "}
                    {provider.approval_status}
                  </p>
                </div>

                <div className="mt-6 flex flex-wrap gap-3">
                  {provider.insurance_status === "pending" && (
                    <>
                      <button
                        onClick={() =>
                          updateInsuranceStatus(
                            provider.user_id,
                            "approved"
                          )
                        }
                        disabled={updatingUserId === provider.user_id}
                        className="rounded bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
                      >
                        Approve Insurance
                      </button>

                      <button
                        onClick={() =>
                          updateInsuranceStatus(
                            provider.user_id,
                            "rejected"
                          )
                        }
                        disabled={updatingUserId === provider.user_id}
                        className="rounded bg-red-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
                      >
                        Reject Insurance
                      </button>
                    </>
                  )}

                  {provider.approval_status === "pending" && (
                    <>
                      <button
                        onClick={() =>
                          updateProviderStatus(
                            provider.user_id,
                            "approved"
                          )
                        }
                        disabled={updatingUserId === provider.user_id}
                        className="rounded bg-green-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
                      >
                        Approve Provider
                      </button>

                      <button
                        onClick={() =>
                          updateProviderStatus(
                            provider.user_id,
                            "rejected"
                          )
                        }
                        disabled={updatingUserId === provider.user_id}
                        className="rounded bg-red-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
                      >
                        Reject Provider
                      </button>
                    </>
                  )}

                  {provider.approval_status === "approved" && (
                    <button
                      onClick={() =>
                        updateProviderStatus(
                          provider.user_id,
                          "suspended"
                        )
                      }
                      disabled={updatingUserId === provider.user_id}
                      className="rounded bg-orange-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
                    >
                      Suspend Provider
                    </button>
                  )}

                  {provider.approval_status === "suspended" && (
                    <button
                      onClick={() =>
                        updateProviderStatus(
                          provider.user_id,
                          "approved"
                        )
                      }
                      disabled={updatingUserId === provider.user_id}
                      className="rounded bg-green-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
                    >
                      Restore Provider
                    </button>
                  )}

                  {provider.approval_status === "rejected" && (
                    <button
                      onClick={() =>
                        updateProviderStatus(
                          provider.user_id,
                          "approved"
                        )
                      }
                      disabled={updatingUserId === provider.user_id}
                      className="rounded bg-green-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
                    >
                      Approve Provider
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}