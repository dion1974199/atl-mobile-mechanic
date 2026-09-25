"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Vehicle = {
  id: string;
  year: number;
  make: string;
  model: string;
};

type ServiceRequest = {
  id: string;
  vehicle_id: string;
  service: string;
  problem_description: string | null;
  status: string;
  created_at: string;
  service_address: string | null;
  service_city: string | null;
  service_zip: string | null;
  request_type: string;
  scheduled_for: string | null;
  vehicle_type: string | null;
  tire_issue: string | null;
  tire_size: string | null;
  highway_interstate: string | null;
  travel_direction: string | null;
  exit_mile_marker: string | null;
};

type ProviderName = {
  first_name: string;
  last_name: string;
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
  authorization_type: "initial" | "change_order";
  parent_authorization_id: string | null;
};

export default function RequestsPage() {
  const supabase = createClient();

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [requests, setRequests] = useState<ServiceRequest[]>([]);
  const [providerNames, setProviderNames] = useState<
    Record<string, ProviderName>
  >({});
  const [openConversationId, setOpenConversationId] = useState<string | null>(null);
  const [messagesByRequest, setMessagesByRequest] = useState<
    Record<string, ServiceMessage[]>
  >({});
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [sendingMessageId, setSendingMessageId] = useState<string | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [repairAuthorizations, setRepairAuthorizations] = useState<
    Record<string, RepairAuthorization>
  >({});
  const [respondingAuthorizationId, setRespondingAuthorizationId] =
    useState<string | null>(null);

  const [vehicleId, setVehicleId] = useState("");
  const [service, setService] = useState("");
  const [problem, setProblem] = useState("");

  const [serviceAddress, setServiceAddress] = useState("");
  const [serviceCity, setServiceCity] = useState("");
  const [serviceZip, setServiceZip] = useState("");
  const [requestType, setRequestType] = useState<"asap" | "scheduled">("asap");
  const [scheduledFor, setScheduledFor] = useState("");

  const [vehicleType, setVehicleType] = useState("");
  const [tireIssue, setTireIssue] = useState("");
  const [tireSize, setTireSize] = useState("");
  const [highwayInterstate, setHighwayInterstate] = useState("");
  const [travelDirection, setTravelDirection] = useState("");
  const [exitMileMarker, setExitMileMarker] = useState("");
  useEffect(() => {
    loadPage();
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("customer-service-requests")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "service_requests",
        },
        async () => {
          const {
            data: { user },
          } = await supabase.auth.getUser();

          if (user) {
            await loadRequests(user.id);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("customer-service-messages")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "service_messages",
        },
        async () => {
          await loadUnreadCounts();

          if (openConversationId) {
            await loadMessages(openConversationId);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [openConversationId]);

  useEffect(() => {
    const channel = supabase
      .channel("customer-repair-authorizations")
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

  async function loadPage() {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      window.location.href = "/auth/login";
      return;
    }

    const role = user.user_metadata?.role;

    if (role === "mechanic") {
      window.location.href = "/mechanic";
      return;
    }

    if (role === "tire_technician") {
      window.location.href = "/tire-technician";
      return;
    }

    if (role !== "customer") {
      window.location.href = "/auth/login";
      return;
    }

    setCurrentUserId(user.id);

    await Promise.all([
      loadVehicles(user.id),
      loadRequests(user.id),
      loadUnreadCounts(),
      loadRepairAuthorizations(),
    ]);
  }

  async function loadVehicles(customerId: string) {
    const { data, error } = await supabase
      .from("vehicles")
      .select("id, year, make, model")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
      return;
    }

    setVehicles(data || []);
  }

  async function loadRequests(customerId: string) {
    const { data, error } = await supabase
      .from("service_requests")
      .select(
        `
        id,
        vehicle_id,
        service,
        problem_description,
        status,
        created_at,
        service_address,
        service_city,
        service_zip,
        request_type,
        scheduled_for,
        vehicle_type,
        tire_issue,
        tire_size,
        highway_interstate,
        travel_direction,
        exit_mile_marker
        `
      )
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
      return;
    }

    const loadedRequests = data || [];
    setRequests(loadedRequests);

    const assignedRequests = loadedRequests.filter((request) =>
      ["accepted", "on_the_way", "in_progress", "completed"].includes(
        request.status
      )
    );

    const providerEntries = await Promise.all(
      assignedRequests.map(async (request) => {
        const { data: providerData, error: providerError } =
          await supabase.rpc("get_customer_request_provider", {
            request_id: request.id,
          });

        if (providerError || !providerData || providerData.length === 0) {
          return null;
        }

        return [
          request.id,
          {
            first_name: providerData[0].first_name,
            last_name: providerData[0].last_name,
          },
        ] as const;
      })
    );

    const nextProviderNames: Record<string, ProviderName> = {};

    for (const entry of providerEntries) {
      if (entry) {
        nextProviderNames[entry[0]] = entry[1];
      }
    }

    setProviderNames(nextProviderNames);
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

    const latestByRequest: Record<string, RepairAuthorization> = {};

    for (const item of data || []) {
      if (!latestByRequest[item.request_id]) {
        latestByRequest[item.request_id] = item as RepairAuthorization;
      }
    }

    setRepairAuthorizations(latestByRequest);
  }

  async function respondToRepairAuthorization(
    authorizationId: string,
    newStatus: "approved" | "declined"
  ) {
    const action = newStatus === "approved" ? "approve" : "decline";
    const confirmed = window.confirm(
      `Are you sure you want to ${action} this repair authorization?`
    );

    if (!confirmed) return;

    setRespondingAuthorizationId(authorizationId);

    const { error } = await supabase.rpc(
      "respond_to_repair_authorization",
      {
        authorization_id: authorizationId,
        new_status: newStatus,
        response_note: null,
      }
    );

    setRespondingAuthorizationId(null);

    if (error) {
      alert(error.message);
      return;
    }

    await loadRepairAuthorizations();
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
      alert(error.message);
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

  async function sendMessage(requestId: string) {
    const message = (messageDrafts[requestId] || "").trim();
    if (!message) return;

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
      message,
    });

    setSendingMessageId(null);

    if (error) {
      alert(error.message);
      return;
    }

    setMessageDrafts((current) => ({ ...current, [requestId]: "" }));
    await loadMessages(requestId);
    await loadUnreadCounts();
  }

  async function createPayment(requestId: string) {
  const { data, error } = await supabase.rpc(
    "create_service_payment",
    {
      request_id_input: requestId,
    }
  );

  if (error) {
    alert(error.message);
    return;
  }

  alert(`Payment record created successfully. Payment ID: ${data}`);
}
  async function cancelRequest(requestId: string) {
    const confirmed = window.confirm(
      "Are you sure you want to cancel this service request?"
    );

    if (!confirmed) return;

    const { error } = await supabase.rpc(
      "cancel_customer_request",
      {
        request_id: requestId,
      }
    );

    if (error) {
      alert(error.message);
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      await loadRequests(user.id);
    }
  }

  async function handleContinue() {
    if (!vehicleId) {
      alert("Please select a vehicle.");
      return;
    }

    if (!service) {
      alert("Please select a service.");
      return;
    }

    if (!serviceCity.trim()) {
      alert("Please enter the city.");
      return;
    }

    if (!serviceZip.trim()) {
      alert("Please enter the ZIP code.");
      return;
    }

    if (service === "tires") {
      if (!vehicleType) {
        alert("Please select the vehicle type.");
        return;
      }

      if (!tireIssue) {
        alert("Please select the tire problem.");
        return;
      }

      if (!serviceAddress.trim() && !highwayInterstate.trim()) {
        alert(
          "Please enter either a street address or highway/interstate information."
        );
        return;
      }
    } else {
      if (!serviceAddress.trim()) {
        alert("Please enter the street address.");
        return;
      }
    }

    if (requestType === "scheduled" && !scheduledFor) {
      alert("Please select a date and time for your scheduled service.");
      return;
    }

    if (requestType === "scheduled" && new Date(scheduledFor).getTime() <= Date.now()) {
      alert("Please select a future date and time.");
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      window.location.href = "/auth/login";
      return;
    }

    const { error } = await supabase
      .from("service_requests")
      .insert({
        customer_id: user.id,
        vehicle_id: vehicleId,
        service,
        problem_description: problem || null,
        service_address: serviceAddress || null,
        service_city: serviceCity,
        service_zip: serviceZip,
        request_type: requestType,
        scheduled_for: requestType === "scheduled" ? new Date(scheduledFor).toISOString() : null,
        vehicle_type:
          service === "tires" ? vehicleType : null,
        tire_issue:
          service === "tires" ? tireIssue : null,
        tire_size:
          service === "tires"
            ? tireSize || null
            : null,
        highway_interstate:
          service === "tires"
            ? highwayInterstate || null
            : null,
        travel_direction:
          service === "tires"
            ? travelDirection || null
            : null,
        exit_mile_marker:
          service === "tires"
            ? exitMileMarker || null
            : null,
      });

    if (error) {
      alert(error.message);
      return;
    }

    alert("Your mechanic request was submitted! 🔧🚗");

    setVehicleId("");
    setService("");
    setProblem("");

    setServiceAddress("");
    setServiceCity("");
    setServiceZip("");
    setRequestType("asap");
    setScheduledFor("");

    setVehicleType("");
    setTireIssue("");
    setTireSize("");
    setHighwayInterstate("");
    setTravelDirection("");
    setExitMileMarker("");

    await loadRequests(user.id);
  }

  function getVehicleName(id: string) {
    const vehicle = vehicles.find(
      (v) => v.id === id
    );

    if (!vehicle) return "Vehicle";

    return `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
  }

  function formatVehicleType(value: string | null) {
    if (!value) return "Not provided";
    if (value === "car") return "Car";
    if (value === "light_truck")
      return "Light Truck / SUV";
    if (value === "commercial_truck")
      return "Commercial Truck";

    return value;
  }

  function formatTireIssue(value: string | null) {
    if (!value) return "Not provided";
    if (value === "flat") return "Flat Tire";
    if (value === "blowout") return "Blowout";
    if (value === "slow_leak")
      return "Slow Leak";
    if (value === "damaged_tire")
      return "Damaged Tire";
    if (value === "needs_replacement")
      return "Needs Replacement";
    if (value === "other") return "Other";

    return value;
  }

  function formatDirection(value: string | null) {
    if (!value) return "Not provided";
    if (value === "northbound")
      return "Northbound";
    if (value === "southbound")
      return "Southbound";
    if (value === "eastbound")
      return "Eastbound";
    if (value === "westbound")
      return "Westbound";

    return value;
  }

  function formatStatus(status: string) {
    if (status === "open") return "Open";
    if (status === "accepted") return "Accepted";
    if (status === "on_the_way")
      return "On the Way";
    if (status === "in_progress")
      return "In Progress";
    if (status === "completed")
      return "Completed";
    if (status === "cancelled")
      return "Cancelled";

    return status;
  }
function getStatusColor(status: string) {
  if (status === "open") return "bg-yellow-100 text-yellow-800";
  if (status === "accepted") return "bg-blue-100 text-blue-800";
  if (status === "on_the_way") return "bg-purple-100 text-purple-800";
  if (status === "in_progress") return "bg-orange-100 text-orange-800";
  if (status === "completed") return "bg-green-100 text-green-800";
  if (status === "cancelled") return "bg-red-100 text-red-800";

  return "bg-gray-100 text-gray-800";
}function getProgressStep(status: string) {
  if (status === "open") return 1;
  if (status === "accepted") return 2;
  if (status === "on_the_way") return 3;
  if (status === "in_progress") return 4;
  if (status === "completed") return 5;

  return 0;
}

function isActiveRequest(status: string) {
  return !["completed", "cancelled"].includes(status);
}

function isHistoryRequest(status: string) {
  return ["completed", "cancelled"].includes(status);
}

function getProviderLabel(service: string) {
  return service === "tires" ? "Tire Technician" : "Mechanic";
}
  return (
    <main className="min-h-screen bg-gray-50 p-10">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-gray-900">
            🔧 Request a Mobile Mechanic
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

        <p className="mt-2 text-gray-600">
          Tell us what your vehicle needs.
        </p>

        <div className="mt-8 rounded-lg border bg-white p-6 shadow-sm">
          <label className="font-semibold">
            Which vehicle needs service?
          </label>

          <select
            className="mt-2 w-full rounded border p-3"
            value={vehicleId}
            onChange={(e) =>
              setVehicleId(e.target.value)
            }
          >
            <option value="">
              Select your vehicle
            </option>

            {vehicles.map((vehicle) => (
              <option
                key={vehicle.id}
                value={vehicle.id}
              >
                {vehicle.year} {vehicle.make}{" "}
                {vehicle.model}
              </option>
            ))}
          </select>

          <div className="mt-6">
            <label className="font-semibold">
              What service do you need?
            </label>

            <select
              className="mt-2 w-full rounded border p-3"
              value={service}
              onChange={(e) =>
                setService(e.target.value)
              }
            >
              <option value="">
                Select a service
              </option>
              <option value="diagnostic">
                Check Engine / Diagnostic
              </option>
              <option value="oil_change">
                Oil Change
              </option>
              <option value="brakes">
                Brakes
              </option>
              <option value="battery">
                Battery
              </option>
              <option value="alternator">
                Alternator
              </option>
              <option value="starter">
                Starter
              </option>
              <option value="tires">
                Tires
              </option>
              <option value="ac">
                AC / Heating
              </option>
              <option value="engine">
                Engine Repair
              </option>
              <option value="transmission">
                Transmission
              </option>
              <option value="other">
                Other
              </option>
            </select>
          </div>

          {service && (
            <div className="mt-6">
              <p className="rounded bg-gray-100 p-3">
                You selected:{" "}
                <strong>{service}</strong>
              </p>

              {service === "tires" && (
                <div className="mt-6 rounded-lg border bg-gray-50 p-4">
                  <h2 className="text-lg font-bold">
                    🛞 Tire Service Details
                  </h2>

                  <label className="mt-4 block font-medium">
                    Vehicle Type
                  </label>

                  <select
                    className="mt-2 w-full rounded-md border-2 border-gray-400 bg-white p-3 text-black"
                    value={vehicleType}
                    onChange={(e) =>
                      setVehicleType(
                        e.target.value
                      )
                    }
                  >
                    <option value="">
                      Select vehicle type
                    </option>
                    <option value="car">
                      Car
                    </option>
                    <option value="light_truck">
                      Light Truck / SUV
                    </option>
                    <option value="commercial_truck">
                      Commercial Truck
                    </option>
                  </select>

                  <label className="mt-4 block font-medium">
                    Tire Problem
                  </label>

                  <select
                    className="mt-2 w-full rounded-md border-2 border-gray-400 bg-white p-3 text-black"
                    value={tireIssue}
                    onChange={(e) =>
                      setTireIssue(e.target.value)
                    }
                  >
                    <option value="">
                      Select tire problem
                    </option>
                    <option value="flat">
                      Flat Tire
                    </option>
                    <option value="blowout">
                      Blowout
                    </option>
                    <option value="slow_leak">
                      Slow Leak
                    </option>
                    <option value="damaged_tire">
                      Damaged Tire
                    </option>
                    <option value="needs_replacement">
                      Needs Replacement
                    </option>
                    <option value="other">
                      Other
                    </option>
                  </select>

                  <label className="mt-4 block font-medium">
                    Tire Size
                  </label>

                  <input
                    className="mt-2 w-full rounded-md border-2 border-gray-400 bg-white p-3 text-black"
                    type="text"
                    placeholder="Example: 225/65R17"
                    value={tireSize}
                    onChange={(e) =>
                      setTireSize(e.target.value)
                    }
                  />

                  <label className="mt-4 block font-medium">
                    Highway / Interstate
                  </label>

                  <input
                    className="mt-2 w-full rounded-md border-2 border-gray-400 bg-white p-3 text-black"
                    type="text"
                    placeholder="Example: I-285"
                    value={highwayInterstate}
                    onChange={(e) =>
                      setHighwayInterstate(
                        e.target.value
                      )
                    }
                  />

                  <label className="mt-4 block font-medium">
                    Travel Direction
                  </label>

                  <select
                    className="mt-2 w-full rounded-md border-2 border-gray-400 bg-white p-3 text-black"
                    value={travelDirection}
                    onChange={(e) =>
                      setTravelDirection(
                        e.target.value
                      )
                    }
                  >
                    <option value="">
                      Select direction
                    </option>
                    <option value="northbound">
                      Northbound
                    </option>
                    <option value="southbound">
                      Southbound
                    </option>
                    <option value="eastbound">
                      Eastbound
                    </option>
                    <option value="westbound">
                      Westbound
                    </option>
                  </select>

                  <label className="mt-4 block font-medium">
                    Exit / Mile Marker
                  </label>

                  <input
                    className="mt-2 w-full rounded-md border-2 border-gray-400 bg-white p-3 text-black"
                    type="text"
                    placeholder="Example: Exit 42 or Mile Marker 18"
                    value={exitMileMarker}
                    onChange={(e) =>
                      setExitMileMarker(
                        e.target.value
                      )
                    }
                  />
                </div>
              )}

              <label className="mt-6 block font-semibold">
                Describe the problem
              </label>

              <textarea
                className="mt-2 w-full rounded-md border-2 border-gray-400 bg-white p-3 text-black"
                rows={5}
                placeholder="Example: My car makes a clicking noise when I try to start it."
                value={problem}
                onChange={(e) =>
                  setProblem(e.target.value)
                }
              />

              <p className="mt-2 text-sm text-gray-500">
                Tell the mechanic what you are
                experiencing.
              </p>

              <div className="mt-6">
                <h2 className="font-semibold">
                  Where is the vehicle located?
                </h2>

                {service === "tires" && (
                  <p className="mt-2 text-sm text-gray-500">
                    For roadside tire service,
                    enter either a street address
                    or your highway/interstate
                    information above.
                  </p>
                )}

                <label className="mt-4 block font-medium">
                  Street Address
                </label>

                <input
                  className="mt-2 w-full rounded-md border-2 border-gray-400 bg-white p-3 text-black"
                  type="text"
                  placeholder="123 Main Street"
                  value={serviceAddress}
                  onChange={(e) =>
                    setServiceAddress(
                      e.target.value
                    )
                  }
                />

                <label className="mt-4 block font-medium">
                  City
                </label>

                <input
                  className="mt-2 w-full rounded-md border-2 border-gray-400 bg-white p-3 text-black"
                  type="text"
                  placeholder="Atlanta"
                  value={serviceCity}
                  onChange={(e) =>
                    setServiceCity(e.target.value)
                  }
                />

                <label className="mt-4 block font-medium">
                  ZIP Code
                </label>

                <input
                  className="mt-2 w-full rounded-md border-2 border-gray-400 bg-white p-3 text-black"
                  type="text"
                  placeholder="30301"
                  value={serviceZip}
                  onChange={(e) =>
                    setServiceZip(e.target.value)
                  }
                />
                <div className="mt-6">
                  <h2 className="font-semibold">
                    When do you need service?
                  </h2>

                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setRequestType("asap");
                        setScheduledFor("");
                      }}
                      className={`rounded-md border-2 p-3 font-semibold ${
                        requestType === "asap"
                          ? "border-black bg-black text-white"
                          : "border-gray-400 bg-white text-black"
                      }`}
                    >
                      ASAP
                    </button>

                    <button
                      type="button"
                      onClick={() => setRequestType("scheduled")}
                      className={`rounded-md border-2 p-3 font-semibold ${
                        requestType === "scheduled"
                          ? "border-black bg-black text-white"
                          : "border-gray-400 bg-white text-black"
                      }`}
                    >
                      Schedule for Later
                    </button>
                  </div>

                  {requestType === "scheduled" && (
                    <div className="mt-4">
                      <label className="block font-medium">
                        Preferred Date & Time
                      </label>
                      <input
                        type="datetime-local"
                        className="mt-2 w-full rounded-md border-2 border-gray-400 bg-white p-3 text-black"
                        value={scheduledFor}
                        onChange={(e) => setScheduledFor(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              </div>

              <button
                type="button"
                className="mt-6 w-full rounded bg-black px-4 py-3 font-semibold text-white hover:bg-gray-800"
                onClick={handleContinue}
              >
                Continue
              </button>
            </div>
          )}
        </div>

        <div className="mt-10">
          <h2 className="text-2xl font-bold text-gray-900">
            🔧 Active Requests
          </h2>

          {requests.filter((request) =>
            isActiveRequest(request.status)
          ).length === 0 ? (
            <p className="mt-4 text-gray-500">
              You don&apos;t have any active service requests.
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              {requests
                .filter((request) =>
                  isActiveRequest(request.status)
                )
                .map((request) => (
                  <div
                    key={request.id}
               className="rounded-lg border bg-white p-5 text-gray-900 shadow-sm"
                  >
                    <h3 className="text-lg font-bold">
                      🚗 {getVehicleName(request.vehicle_id)}
                    </h3>

                    <p className="mt-2">
                      <strong>Service:</strong>{" "}
                      {request.service}
                    </p>

                    <p className="mt-2">
                      <strong>Problem:</strong>{" "}
                      {request.problem_description || "Not provided"}
                    </p>

                    {request.service === "tires" && (
                      <div className="mt-4 rounded bg-gray-50 p-4">
                        <p>
                          <strong>Vehicle Type:</strong>{" "}
                          {formatVehicleType(request.vehicle_type)}
                        </p>

                        <p className="mt-2">
                          <strong>Tire Problem:</strong>{" "}
                          {formatTireIssue(request.tire_issue)}
                        </p>

                        <p className="mt-2">
                          <strong>Tire Size:</strong>{" "}
                          {request.tire_size || "Not provided"}
                        </p>

                        <p className="mt-2">
                          <strong>Highway / Interstate:</strong>{" "}
                          {request.highway_interstate || "Not provided"}
                        </p>

                        <p className="mt-2">
                          <strong>Travel Direction:</strong>{" "}
                          {formatDirection(request.travel_direction)}
                        </p>

                        <p className="mt-2">
                          <strong>Exit / Mile Marker:</strong>{" "}
                          {request.exit_mile_marker || "Not provided"}
                        </p>
                      </div>
                    )}

                    <p className="mt-4">
                      <strong>Location:</strong>{" "}
                      {request.service_address || "Not provided"}
                      {request.service_city
                        ? `, ${request.service_city}`
                        : ""}
                      {request.service_zip
                        ? `, ${request.service_zip}`
                        : ""}
                    </p>

                    <p className="mt-3">
                      <strong>Service Timing:</strong>{" "}
                      {request.request_type === "scheduled" && request.scheduled_for
                        ? new Date(request.scheduled_for).toLocaleString()
                        : "ASAP"}
                    </p>
                    <p className="mt-3">
                      <strong>Status:</strong>{" "}
                      <span
                        className={`rounded px-2 py-1 ${getStatusColor(
                          request.status
                        )}`}
                      >
                        {formatStatus(request.status)}
                      </span>
                    </p>

                    {providerNames[request.id] && (
                      <div className="mt-4 rounded bg-blue-50 p-4 text-gray-900">
                        <p className="font-semibold">
                          {getProviderLabel(request.service)} Assigned
                        </p>
                        <p className="mt-1">
                          <strong>Provider:</strong>{" "}
                          {providerNames[request.id].first_name}{" "}
                          {providerNames[request.id].last_name}
                        </p>
                      </div>
                    )}

                    {repairAuthorizations[request.id] && (
                      <div className="mt-4 rounded border-2 border-amber-300 bg-amber-50 p-4 text-gray-900">
                        <h4 className="text-lg font-bold">
                          {repairAuthorizations[request.id].authorization_type ===
                          "change_order"
                            ? "Change Order"
                            : "Repair Authorization"}
                        </h4>

                        <p className="mt-2">
                          <strong>Status:</strong>{" "}
                          {repairAuthorizations[request.id].status === "pending"
                            ? "Pending Your Approval"
                            : repairAuthorizations[request.id].status === "approved"
                            ? "Approved"
                            : "Declined"}
                        </p>

                        <p className="mt-2">
                          <strong>Work:</strong>{" "}
                          {repairAuthorizations[request.id].description}
                        </p>

                        <p className="mt-2">
                          <strong>Parts:</strong> $
                          {Number(
                            repairAuthorizations[request.id].parts_amount
                          ).toFixed(2)}
                        </p>

                        <p className="mt-2">
                          <strong>Labor:</strong> $
                          {Number(
                            repairAuthorizations[request.id].labor_amount
                          ).toFixed(2)}
                        </p>

                        <p className="mt-2 text-lg font-bold">
                          Total: $
                          {Number(
                            repairAuthorizations[request.id].total_amount
                          ).toFixed(2)}
                        </p>

                        {repairAuthorizations[request.id].status === "pending" && (
                          <div className="mt-4 flex flex-wrap gap-3">
                            <button
                              type="button"
                              disabled={
                                respondingAuthorizationId ===
                                repairAuthorizations[request.id].id
                              }
                              onClick={() =>
                                respondToRepairAuthorization(
                                  repairAuthorizations[request.id].id,
                                  "approved"
                                )
                              }
                              className="rounded bg-green-700 px-4 py-2 font-semibold text-white hover:bg-green-800 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Approve $ 
                              {Number(
                                repairAuthorizations[request.id].total_amount
                              ).toFixed(2)}
                            </button>

                            <button
                              type="button"
                              disabled={
                                respondingAuthorizationId ===
                                repairAuthorizations[request.id].id
                              }
                              onClick={() =>
                                respondToRepairAuthorization(
                                  repairAuthorizations[request.id].id,
                                  "declined"
                                )
                              }
                              className="rounded bg-red-700 px-4 py-2 font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Decline
                              </button>
                          </div>
                        )}

                        {repairAuthorizations[request.id].status === "approved" && (
<button type="button" onClick={() => createPayment(request.id)} className="mt-4 rounded bg-black px-4 py-2 font-semibold text-white hover:bg-gray-800">Test Create Payment</button>
)}

{repairAuthorizations[request.id].responded_at && (
                          <p className="mt-3 text-sm text-gray-600">
                            Responded:{" "}
                            {new Date(
                              repairAuthorizations[request.id].responded_at as string
                            ).toLocaleString()}
                          </p>
                        )}
                      </div>
                    )}

                    {["accepted", "on_the_way", "in_progress"].includes(
                      request.status
                    ) && providerNames[request.id] && (
                      <div className="mt-4">
                        <button
                          type="button"
                          onClick={() => toggleConversation(request.id)}
                          className="rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800"
                        >
                          {openConversationId === request.id
                            ? "Close Messages"
                            : `Message ${getProviderLabel(request.service)}`}

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
                                  No messages yet. Send the first message below.
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
                                        : getProviderLabel(request.service)}
                                    </p>
                                    <p className="whitespace-pre-wrap">{item.message}</p>
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
                              placeholder="Type a message..."
                              className="mt-4 w-full rounded border border-gray-400 bg-white p-3 text-gray-900"
                            />

                            <button
                              type="button"
                              disabled={
                                sendingMessageId === request.id ||
                                !(messageDrafts[request.id] || "").trim()
                              }
                              onClick={() => sendMessage(request.id)}
                              className="mt-2 rounded bg-black px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {sendingMessageId === request.id
                                ? "Sending..."
                                : "Send Message"}
                            </button>
                          </div>
                        )}
                      </div>
                    )}{request.status !== "cancelled" && (
  <div className="mt-4">
    <div className="flex items-center justify-between text-xs font-medium text-gray-600">
      <span>Submitted</span>
      <span>Accepted</span>
      <span>On the Way</span>
      <span>In Progress</span>
      <span>Completed</span>
    </div>

    <div className="mt-2 grid grid-cols-5 gap-2">
      {[1, 2, 3, 4, 5].map((step) => (
        <div
          key={step}
          className={`h-2 rounded ${
            getProgressStep(request.status) >= step
              ? "bg-green-500"
              : "bg-gray-200"
          }`}
        />
      ))}
    </div>
  </div>
)}

                    {request.status === "open" && (
                      <button
                        type="button"
                        className="mt-4 rounded bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-700"
                        onClick={() =>
                          cancelRequest(request.id)
                        }
                      >
                        Cancel Request
                      </button>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>

        <div className="mt-12">
          <h2 className="text-2xl font-bold text-gray-900">
            📚 Request History
          </h2>

          {requests.filter((request) =>
            isHistoryRequest(request.status)
          ).length === 0 ? (
            <p className="mt-4 text-gray-500">
              You don&apos;t have any completed or cancelled requests yet.
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              {requests
                .filter((request) =>
                  isHistoryRequest(request.status)
                )
                .map((request) => (
                  <div
                    key={request.id}
                    className="rounded-lg border bg-white p-5 text-gray-900 shadow-sm"
                  >
                    <h3 className="text-lg font-bold">
                      🚗 {getVehicleName(request.vehicle_id)}
                    </h3>

                    <p className="mt-2">
                      <strong>Service:</strong>{" "}
                      {request.service}
                    </p>

                    <p className="mt-2">
                      <strong>Problem:</strong>{" "}
                      {request.problem_description || "Not provided"}
                    </p>

                    {request.service === "tires" && (
                      <div className="mt-4 rounded bg-gray-50 p-4">
                        <p>
                          <strong>Vehicle Type:</strong>{" "}
                          {formatVehicleType(request.vehicle_type)}
                        </p>

                        <p className="mt-2">
                          <strong>Tire Problem:</strong>{" "}
                          {formatTireIssue(request.tire_issue)}
                        </p>

                        <p className="mt-2">
                          <strong>Tire Size:</strong>{" "}
                          {request.tire_size || "Not provided"}
                        </p>

                        <p className="mt-2">
                          <strong>Highway / Interstate:</strong>{" "}
                          {request.highway_interstate || "Not provided"}
                        </p>

                        <p className="mt-2">
                          <strong>Travel Direction:</strong>{" "}
                          {formatDirection(request.travel_direction)}
                        </p>

                        <p className="mt-2">
                          <strong>Exit / Mile Marker:</strong>{" "}
                          {request.exit_mile_marker || "Not provided"}
                        </p>
                      </div>
                    )}

                    <p className="mt-4">
                      <strong>Location:</strong>{" "}
                      {request.service_address || "Not provided"}
                      {request.service_city
                        ? `, ${request.service_city}`
                        : ""}
                      {request.service_zip
                        ? `, ${request.service_zip}`
                        : ""}
                    </p>

                    <p className="mt-3">
                      <strong>Service Timing:</strong>{" "}
                      {request.request_type === "scheduled" && request.scheduled_for
                        ? new Date(request.scheduled_for).toLocaleString()
                        : "ASAP"}
                    </p>
                    <p className="mt-3">
                      <strong>Status:</strong>{" "}
                      <span
                        className={`rounded px-2 py-1 ${getStatusColor(
                          request.status
                        )}`}
                      >
                        {formatStatus(request.status)}
                      </span>
                    </p>

                    {providerNames[request.id] && (
                      <div className="mt-4 rounded bg-blue-50 p-4 text-gray-900">
                        <p className="font-semibold">
                          {getProviderLabel(request.service)} Assigned
                        </p>
                        <p className="mt-1">
                          <strong>Provider:</strong>{" "}
                          {providerNames[request.id].first_name}{" "}
                          {providerNames[request.id].last_name}
                        </p>
                      </div>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}