"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Vehicle = {
  id: string;
  year: number;
  make: string;
  model: string;
  vin: string | null;
  license_plate: string | null;
};

export default function VehiclesPage() {
  const supabase = createClient();

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
const [makes, setMakes] = useState<string[]>([]);
const [models, setModels] = useState<string[]>([]);
const [vehicleDataLoading, setVehicleDataLoading] = useState(false);
  const [vin, setVin] = useState("");
  const [licensePlate, setLicensePlate] = useState("");
  const [message, setMessage] = useState("");
async function loadMakes() {
  setVehicleDataLoading(true);

  try {
    const response = await fetch(
      "https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/car?format=json"
    );

    const data = await response.json();

    const uniqueMakes = Array.from(
      new Set(
        data.Results.map(
          (item: { MakeName: string }) => item.MakeName
        )
      )
    ).sort() as string[];

    setMakes(uniqueMakes);
  } catch {
    setMessage("Unable to load vehicle makes. Please try again.");
  } finally {
    setVehicleDataLoading(false);
  }
}
async function loadModels(selectedYear: string, selectedMake: string) {
  if (!selectedYear || !selectedMake) {
    setModels([]);
    return;
  }

  setVehicleDataLoading(true);

  try {
    const response = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(
        selectedMake
      )}/modelyear/${selectedYear}?format=json`
    );

    const data = await response.json();

    const uniqueModels = Array.from(
      new Set(
        data.Results.map(
          (item: { Model_Name: string }) => item.Model_Name
        )
      )
    ).sort() as string[];

    setModels(uniqueModels);
  } catch {
    setMessage("Unable to load vehicle models. Please try again.");
    setModels([]);
  } finally {
    setVehicleDataLoading(false);
  }
}

  async function loadVehicles() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const user = session?.user;

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

    const { data, error } = await supabase
      .from("vehicles")
      .select("*")
      .eq("customer_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      setMessage(error.message);
      return;
    }

    setVehicles(data || []);
  }

  useEffect(() => {
    loadVehicles();
    loadMakes();
  }, []);

  async function addVehicle(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");

    const {
      data: { session },
    } = await supabase.auth.getSession();

    const user = session?.user;

    if (!user) {
      window.location.href = "/auth/login";
      return;
    }

    if (user.user_metadata?.role !== "customer") {
      setMessage("Only customers can add vehicles.");
      return;
    }

    const { error } = await supabase.from("vehicles").insert({
      customer_id: user.id,
      year: Number(year),
      make,
      model,
      vin: vin || null,
      license_plate: licensePlate || null,
    });

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage("Vehicle added successfully! 🚗");

    setYear("");
    setMake("");
    setModel("");
    setVin("");
    setLicensePlate("");

    await loadVehicles();
  }

  return (
    <main className="min-h-screen bg-gray-50 p-10">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold">🚙 My Vehicles</h1>

        <p className="mt-2 text-gray-600">
          Add and manage the vehicles you want to service.
        </p>

        <section className="mt-8">
          <h2 className="text-xl font-semibold">My Saved Vehicles</h2>

          {vehicles.length === 0 ? (
            <p className="mt-4 text-gray-500">
              You don&apos;t have any vehicles saved yet.
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              {vehicles.map((vehicle) => (
                <div
                  key={vehicle.id}
                  className="rounded-lg border bg-white p-5 shadow-sm"
                >
                  <h3 className="text-lg font-bold">
                    🚗 {vehicle.year} {vehicle.make} {vehicle.model}
                  </h3>

                  <p className="mt-2">
                    <strong>VIN:</strong>{" "}
                    {vehicle.vin || "Not provided"}
                  </p>

                  <p className="mt-1">
                    <strong>License Plate:</strong>{" "}
                    {vehicle.license_plate || "Not provided"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mt-10 rounded-lg border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold">
            ➕ Add Another Vehicle
          </h2>

          <form onSubmit={addVehicle} className="mt-6 space-y-4">
<select
  className="w-full rounded border p-3"
  value={year}
  onChange={(e) => {
    setYear(e.target.value);
    setModel("");
    setModels([]);
    if (make) {
      loadModels(e.target.value, make);
    }
  }}
  required
>
  <option value="">Select Year</option>
  {Array.from(
    { length: 48 },
    (_, index) => 2027 - index
  ).map((vehicleYear) => (
    <option key={vehicleYear} value={vehicleYear}>
      {vehicleYear}
    </option>
  ))}
</select>
            <select
  className="w-full rounded border p-3"
  value={make}
  onChange={(e) => {
    const selectedMake = e.target.value;
    setMake(selectedMake);
    setModel("");
    setModels([]);
    if (year && selectedMake) {
      loadModels(year, selectedMake);
    }
  }}
  disabled={vehicleDataLoading || makes.length === 0}
  required
>
  <option value="">
    {vehicleDataLoading ? "Loading Makes..." : "Select Make"}
  </option>
  {makes.map((vehicleMake) => (
    <option key={vehicleMake} value={vehicleMake}>
      {vehicleMake}
    </option>
  ))}
</select>

<select
  className="w-full rounded border p-3"
  value={model}
  onChange={(e) => setModel(e.target.value)}
  disabled={!year || !make || vehicleDataLoading || models.length === 0}
  required
>
  <option value="">
    {!year || !make
      ? "Select Year and Make First"
      : vehicleDataLoading
        ? "Loading Models..."
        : "Select Model"}
  </option>
  {models.map((vehicleModel) => (
    <option key={vehicleModel} value={vehicleModel}>
      {vehicleModel}
    </option>
  ))}
</select>
            <input
              className="w-full rounded border p-3"
              type="text"
              placeholder="VIN"
              value={vin}
              onChange={(e) => setVin(e.target.value)}
            />

            <input
              className="w-full rounded border p-3"
              type="text"
              placeholder="License Plate"
              value={licensePlate}
              onChange={(e) => setLicensePlate(e.target.value)}
            />

            <button
              type="submit"
              className="w-full rounded bg-black px-4 py-3 font-semibold text-white hover:bg-gray-800"
            >
              Add Vehicle
            </button>
          </form>

          {message && (
            <p className="mt-4 rounded bg-gray-100 p-3">
              {message}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
