"use client";

import { useEffect, useRef, useState } from "react";
import { loadConnectAndInitialize } from "@stripe/connect-js";
import { createClient } from "@/lib/supabase/client";

type ServiceRequest = {
  id: string;
  service: string;
  problem_description: string | null;
  status: string;
  service_address: string | null;
  service_city: string | null;
  service_zip: string | null;
};

type ServiceMessage = {
  id: string;
  request_id: string;
  sender_id: string;
  message: string;
  created_at: string;
};

type RepairAuthorization = {
  id: string;
  request_id: string;
  description: string;
  parts_amount: number;
  labor_amount: number;
  total_amount: number;
  status: string;
  customer_response_note: string | null;
  created_at: string;
  responded_at: string | null;
  authorization_type?: "initial" | "change_order";
  parent_authorization_id?: string | null;
};

export default function MechanicPage() {
  const supabase = createClient();
  const stripeOnboardingContainerRef = useRef<HTMLDivElement | null>(null);

  const [openRequests, setOpenRequests] = useState<ServiceRequest[]>([]);
  const [assignedRequests, setAssignedRequests] = useState<ServiceRequest[]>([]);
  const [message, setMessage] = useState("");
  const [openConversationId, setOpenConversationId] = useState<string | null>(null);
  const [messagesByRequest, setMessagesByRequest] = useState<
    Record<string, ServiceMessage[]>
  >({});
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [sendingMessageId, setSendingMessageId] = useState<string | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [authorizationsByRequest, setAuthorizationsByRequest] = useState<
    Record<string, RepairAuthorization[]>
  >({});
  const [authorizationDescriptions, setAuthorizationDescriptions] = useState<
    Record<string, string>
  >({});
  const [partsAmounts, setPartsAmounts] = useState<Record<string, string>>({});
  const [laborAmounts, setLaborAmounts] = useState<Record<string, string>>({});
  const [submittingAuthorizationId, setSubmittingAuthorizationId] = useState<
    string | null
  >(null);


  useEffect(() => {
    const container = stripeOnboardingContainerRef.current;
    const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

    if (!container || !publishableKey) {
      return;
    }

    const stripeConnectInstance = loadConnectAndInitialize({
      publishableKey,
      fetchClientSecret: async () => {
        const response = await fetch("/api/stripe/connect/account-session", {
          method: "POST",
        });

        const data = await response.json();

        if (!response.ok || !data.clientSecret) {
          throw new Error(data.error || "Unable to start Stripe onboarding");
        }

        return data.clientSecret;
      },
    });

    const onboardingElement =
      stripeConnectInstance.create("account-onboarding");

    container.replaceChildren(onboardingElement);

    return () => {
      container.replaceChildren();
    };
  }, []);

  useEffect(() => {
    loadJobs();
    loadUnreadCounts();
    loadRepairAuthorizations();
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("mechanic-service-messages")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "service_messages",
        },
        async () => {
          await loadUnreadCounts();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("mechanic-repair-authorizations")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "repair_authorizations",
        },
        async () => {
          await loadRepairAuthorizations();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function loadJobs() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const user = session?.user;

    if (!user) {
      window.location.href = "/auth/login";
      return;
    }

    setCurrentUserId(user.id);

    const role = user.user_metadata?.role;

    if (role === "customer") {
      window.location.href = "/requests";
      return;
    }

    if (role === "tire_technician") {
      window.location.href = "/tire-technician";
      return;
    }

    if (role !== "mechanic") {
      window.location.href = "/auth/login";
      return;
    }

    const { data: openData, error: openError } = await supabase.rpc(
      "get_open_mechanic_jobs"
    );

    if (openError) {
      console.error("Open mechanic jobs error:", JSON.stringify(openError, null, 2));
    } else {
      setOpenRequests(openData || []);
    }

    const { data: assignedData, error: assignedError } = await supabase
      .from("service_requests")
      .select(
        `
        id,
        service,
        problem_description,
        status,
        service_address,
        service_city,
        service_zip
        `
      )
      .eq("provider_id", user.id)
      .in("status", [
        "accepted",
        "on_the_way",
        "in_progress",
        "completed",
      ])
      .order("created_at", { ascending: false });

    if (assignedError) {
      console.error(assignedError);
    } else {
      setAssignedRequests(assignedData || []);
    }
  }

  async function acceptJob(requestId: string) {
    setMessage("");

    const { error } = await supabase.rpc("accept_mechanic_job", {
      request_id: requestId,
    });

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage("Job accepted.");
    await loadJobs();
  }

  async function updateJobStatus(
    requestId: string,
    newStatus: string
  ) {
    setMessage("");

    const { error } = await supabase.rpc(
      "update_mechanic_job_status",
      {
        request_id: requestId,
        new_status: newStatus,
      }
    );

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(`Job updated to ${formatStatus(newStatus)}.`);
    await loadJobs();
  }

  async function loadRepairAuthorizations() {
    const { data, error } = await supabase
      .from("repair_authorizations")
      .select(
        "id, request_id, description, parts_amount, labor_amount, total_amount, status, customer_response_note, created_at, responded_at, authorization_type, parent_authorization_id"
      )
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
      return;
    }

    const grouped: Record<string, RepairAuthorization[]> = {};

    for (const item of data || []) {
      if (!grouped[item.request_id]) {
        grouped[item.request_id] = [];
      }
      grouped[item.request_id].push(item);
    }

    setAuthorizationsByRequest(grouped);
  }

  async function createRepairAuthorization(requestId: string) {
    const description = (authorizationDescriptions[requestId] || "").trim();
    const parts = Number(partsAmounts[requestId] || 0);
    const labor = Number(laborAmounts[requestId] || 0);

    if (!description) {
      setMessage("Enter the work description before sending the authorization.");
      return;
    }

    if (!Number.isFinite(parts) || !Number.isFinite(labor) || parts < 0 || labor < 0) {
      setMessage("Parts and labor amounts must be valid non-negative numbers.");
      return;
    }

    setMessage("");
    setSubmittingAuthorizationId(requestId);

    const { error } = await supabase.rpc("create_repair_authorization", {
      request_id: requestId,
      work_description: description,
      parts_cost: parts,
      labor_cost: labor,
    });

    setSubmittingAuthorizationId(null);

    if (error) {
      setMessage(error.message);
      return;
    }

    setAuthorizationDescriptions((current) => ({ ...current, [requestId]: "" }));
    setPartsAmounts((current) => ({ ...current, [requestId]: "" }));
    setLaborAmounts((current) => ({ ...current, [requestId]: "" }));
    setMessage("Repair authorization sent to the customer.");
    await loadRepairAuthorizations();
  }

  function formatMoney(value: number) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(Number(value || 0));
  }

  async function loadUnreadCounts() {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return;
    }

    const { data, error } = await supabase
      .from("service_messages")
      .select("request_id, sender_id, read_at")
      .neq("sender_id", user.id)
      .is("read_at", null);

    if (error) {
      console.error(error);
      return;
    }

    const nextCounts: Record<string, number> = {};

    for (const row of data || []) {
      nextCounts[row.request_id] = (nextCounts[row.request_id] || 0) + 1;
    }

    setUnreadCounts(nextCounts);
  }

  async function markMessagesRead(requestId: string) {
    const { error } = await supabase.rpc(
      "mark_service_messages_read",
      {
        request_id: requestId,
      }
    );

    if (error) {
      console.error(error);
      return;
    }

    await loadUnreadCounts();
  }

  async function loadMessages(requestId: string) {
    const { data, error } = await supabase
      .from("service_messages")
      .select("id, request_id, sender_id, message, created_at")
      .eq("request_id", requestId)
      .order("created_at", { ascending: true });

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessagesByRequest((current) => ({
      ...current,
      [requestId]: data || [],
    }));
  }

  async function toggleConversation(requestId: string) {
    if (openConversationId === requestId) {
      setOpenConversationId(null);
      return;
    }

    setOpenConversationId(requestId);
    await loadMessages(requestId);
    await markMessagesRead(requestId);
  }

  async function sendServiceMessage(requestId: string) {
    const serviceMessage = (messageDrafts[requestId] || "").trim();
    if (!serviceMessage) return;

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      window.location.href = "/auth/login";
      return;
    }

    setSendingMessageId(requestId);

    const { error } = await supabase.from("service_messages").insert({
      request_id: requestId,
      sender_id: user.id,
      message: serviceMessage,
    });

    setSendingMessageId(null);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessageDrafts((current) => ({
      ...current,
      [requestId]: "",
    }));

    await loadMessages(requestId);
    await loadUnreadCounts();
  }

  function formatLocation(request: ServiceRequest) {
    const parts = [
      request.service_address,
      request.service_city,
      request.service_zip,
    ].filter(Boolean);

    return parts.length > 0 ? parts.join(", ") : "Not provided";
  }

  function formatStatus(status: string) {
    if (status === "open") return "Open";
    if (status === "accepted") return "Accepted";
    if (status === "on_the_way") return "On the Way";
    if (status === "in_progress") return "In Progress";
    if (status === "completed") return "Completed";

    return status;
  }

  function getNextStatus(status: string) {
    if (status === "accepted") return "on_the_way";
    if (status === "on_the_way") return "in_progress";
    if (status === "in_progress") return "completed";

    return null;
  }

  function getButtonText(status: string) {
    if (status === "accepted") return "Mark On the Way";
    if (status === "on_the_way") return "Start Job — Approval Required";
    if (status === "in_progress") return "Mark Completed";

    return "";
  }

  function isActiveJob(status: string) {
    return ["accepted", "on_the_way", "in_progress"].includes(status);
  }

  function isHistoryJob(status: string) {
    return status === "completed";
  }

  const activeJobs = assignedRequests.filter((request) =>
    isActiveJob(request.status)
  );

  const jobHistory = assignedRequests.filter((request) =>
    isHistoryJob(request.status)
  );

  return (
    <main className="min-h-screen bg-gray-50 p-10">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-gray-900">
            🔧 Mechanic Dashboard
          </h1>

          <button
            type="button"
            className="rounded bg-black px-4 py-2 font-semibold text-white"
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.href = "/auth/login";
            }}
          >
            Logout
          </button>
        </div>

        {message && (
          <p className="mt-4 rounded bg-gray-100 p-3 text-gray-900">
            {message}
          </p>
        )}
        <section className="mt-6 rounded-lg border bg-white p-5 text-gray-900 shadow-sm">
          <h2 className="text-xl font-bold">Stripe Payout Setup</h2>
          <p className="mt-2 text-sm text-gray-600">
            Complete Stripe onboarding so payouts can be enabled for your provider account.
          </p>
          <div ref={stripeOnboardingContainerRef} className="mt-4" />
        </section>

        <section className="mt-8">
          <h2 className="text-2xl font-bold text-gray-900">
            Open Service Requests
          </h2>

          <div className="mt-4 space-y-4">
            {openRequests.length === 0 ? (
              <p className="text-gray-500">
                No open requests found.
              </p>
            ) : (
              openRequests.map((request) => (
                <div
                  key={request.id}
                  className="rounded-lg border bg-white p-5 text-gray-900 shadow-sm"
                >
                  <p>
                    <strong>Service:</strong> {request.service}
                  </p>

                  <p className="mt-2">
                    <strong>Problem:</strong>{" "}
                    {request.problem_description || "Not provided"}
                  </p>

                  <p className="mt-2">
                    <strong>Location:</strong>{" "}
                    {formatLocation(request)}
                  </p>

                  <p className="mt-2">
                    <strong>Status:</strong>{" "}
                    {formatStatus(request.status)}
                  </p>

                  <button
                    type="button"
                    className="mt-4 rounded bg-black px-4 py-2 font-semibold text-white"
                    onClick={() => acceptJob(request.id)}
                  >
                    Accept Job
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold text-gray-900">
            🔧 Active Jobs
          </h2>

          <div className="mt-4 space-y-4">
            {activeJobs.length === 0 ? (
              <p className="text-gray-500">
                You do not have any active jobs.
              </p>
            ) : (
              activeJobs.map((request) => {
                const nextStatus = getNextStatus(request.status);

                return (
                  <div
                    key={request.id}
                    className="rounded-lg border bg-white p-5 text-gray-900 shadow-sm"
                  >
                    <p>
                      <strong>Service:</strong> {request.service}
                    </p>

                    <p className="mt-2">
                      <strong>Problem:</strong>{" "}
                      {request.problem_description || "Not provided"}
                    </p>

                    <p className="mt-2">
                      <strong>Location:</strong>{" "}
                      {formatLocation(request)}
                    </p>

                    <p className="mt-2">
                      <strong>Status:</strong>{" "}
                      {formatStatus(request.status)}
                    </p>

                    <div className="mt-5 rounded border border-gray-300 bg-gray-50 p-4">
                      <h3 className="font-bold">
                        {(authorizationsByRequest[request.id] || []).some(
                          (authorization) => authorization.status === "approved"
                        )
                          ? "Change Order"
                          : "Repair Authorization"}
                      </h3>

                      {(authorizationsByRequest[request.id] || []).length > 0 && (
                        <div className="mt-3 space-y-3">
                          {(authorizationsByRequest[request.id] || []).map((authorization) => (
                            <div
                              key={authorization.id}
                              className="rounded border border-gray-200 bg-white p-3"
                            >
                              <p>
                                <strong>Status:</strong>{" "}
                                {authorization.status.charAt(0).toUpperCase() +
                                  authorization.status.slice(1)}
                              </p>
                              <p className="mt-1">
                                <strong>Work:</strong> {authorization.description}
                              </p>
                              <p className="mt-1">
                                <strong>Parts:</strong>{" "}
                                {formatMoney(authorization.parts_amount)}
                              </p>
                              <p className="mt-1">
                                <strong>Labor:</strong>{" "}
                                {formatMoney(authorization.labor_amount)}
                              </p>
                              <p className="mt-1 font-bold">
                                Total: {formatMoney(authorization.total_amount)}
                              </p>
                              {authorization.customer_response_note && (
                                <p className="mt-1">
                                  <strong>Customer note:</strong>{" "}
                                  {authorization.customer_response_note}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {!(authorizationsByRequest[request.id] || []).some(
                        (authorization) => authorization.status === "pending"
                      ) && (
                        <div className="mt-4">
                          <textarea
                            value={authorizationDescriptions[request.id] || ""}
                            onChange={(event) =>
                              setAuthorizationDescriptions((current) => ({
                                ...current,
                                [request.id]: event.target.value,
                              }))
                            }
                            rows={3}
                            maxLength={1500}
                            placeholder="Describe the work the customer is approving..."
                            className="w-full rounded border border-gray-400 bg-white p-3 text-gray-900"
                          />

                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            <label className="text-sm font-semibold">
                              Parts amount
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={partsAmounts[request.id] || ""}
                                onChange={(event) =>
                                  setPartsAmounts((current) => ({
                                    ...current,
                                    [request.id]: event.target.value,
                                  }))
                                }
                                placeholder="0.00"
                                className="mt-1 w-full rounded border border-gray-400 bg-white p-2 text-gray-900"
                              />
                            </label>

                            <label className="text-sm font-semibold">
                              Labor amount
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={laborAmounts[request.id] || ""}
                                onChange={(event) =>
                                  setLaborAmounts((current) => ({
                                    ...current,
                                    [request.id]: event.target.value,
                                  }))
                                }
                                placeholder="0.00"
                                className="mt-1 w-full rounded border border-gray-400 bg-white p-2 text-gray-900"
                              />
                            </label>
                          </div>

                          <p className="mt-3 font-bold">
                            Proposed Total:{" "}
                            {formatMoney(
                              Number(partsAmounts[request.id] || 0) +
                                Number(laborAmounts[request.id] || 0)
                            )}
                          </p>

                          <button
                            type="button"
                            disabled={submittingAuthorizationId === request.id}
                            onClick={() => createRepairAuthorization(request.id)}
                            className="mt-3 rounded bg-emerald-700 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {submittingAuthorizationId === request.id
                              ? "Sending..."
                              : (authorizationsByRequest[request.id] || []).some(
                                  (authorization) =>
                                    authorization.status === "approved"
                                )
                              ? "Send Change Order"
                              : "Send Repair Authorization"}
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="mt-4">
                      <button
                        type="button"
                        onClick={() => toggleConversation(request.id)}
                        className="rounded bg-blue-700 px-4 py-2 font-semibold text-white"
                      >
                        {openConversationId === request.id
                          ? "Close Messages"
                          : "Message Customer"}

                        {openConversationId !== request.id &&
                          (unreadCounts[request.id] || 0) > 0 && (
                            <span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
                              {unreadCounts[request.id]} new
                            </span>
                          )}
                      </button>

                      {openConversationId === request.id && (
                        <div className="mt-3 rounded border border-gray-300 bg-gray-50 p-4 text-gray-900">
                          <p className="font-bold">Service Messages</p>

                          <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
                            {(messagesByRequest[request.id] || []).length === 0 ? (
                              <p className="text-sm text-gray-600">
                                No messages yet.
                              </p>
                            ) : (
                              (messagesByRequest[request.id] || []).map((item) => (
                                <div
                                  key={item.id}
                                  className="rounded bg-white p-3 shadow-sm"
                                >
                                  <p className="mb-1 text-sm font-bold text-gray-700">
                                    {item.sender_id === currentUserId
                                      ? "You"
                                      : "Customer"}
                                  </p>
                                  <p className="whitespace-pre-wrap">
                                    {item.message}
                                  </p>
                                  <p className="mt-1 text-xs text-gray-500">
                                    {new Date(item.created_at).toLocaleString()}
                                  </p>
                                </div>
                              ))
                            )}
                          </div>

                          <textarea
                            value={messageDrafts[request.id] || ""}
                            onChange={(event) =>
                              setMessageDrafts((current) => ({
                                ...current,
                                [request.id]: event.target.value,
                              }))
                            }
                            rows={3}
                            maxLength={1000}
                            placeholder="Type a message to the customer..."
                            className="mt-4 w-full rounded border border-gray-400 bg-white p-3 text-gray-900"
                          />

                          <button
                            type="button"
                            disabled={
                              sendingMessageId === request.id ||
                              !(messageDrafts[request.id] || "").trim()
                            }
                            onClick={() => sendServiceMessage(request.id)}
                            className="mt-2 rounded bg-black px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {sendingMessageId === request.id
                              ? "Sending..."
                              : "Send Message"}
                          </button>
                        </div>
                      )}
                    </div>

                    {nextStatus && (
                      <button
                        type="button"
                        className="mt-4 rounded bg-black px-4 py-2 font-semibold text-white"
                        onClick={() =>
                          updateJobStatus(request.id, nextStatus)
                        }
                      >
                        {getButtonText(request.status)}
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl font-bold text-gray-900">
            📚 Job History
          </h2>

          <div className="mt-4 space-y-4">
            {jobHistory.length === 0 ? (
              <p className="text-gray-500">
                You do not have any completed jobs yet.
              </p>
            ) : (
              jobHistory.map((request) => (
                <div
                  key={request.id}
                  className="rounded-lg border bg-white p-5 text-gray-900 shadow-sm"
                >
                  <p>
                    <strong>Service:</strong> {request.service}
                  </p>

                  <p className="mt-2">
                    <strong>Problem:</strong>{" "}
                    {request.problem_description || "Not provided"}
                  </p>

                  <p className="mt-2">
                    <strong>Location:</strong>{" "}
                    {formatLocation(request)}
                  </p>

                  <p className="mt-2">
                    <strong>Status:</strong>{" "}
                    {formatStatus(request.status)}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
