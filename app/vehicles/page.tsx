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
  const [vin, setVin] = useState("");
  const [licensePlate, setLicensePlate] = useState("");
  const [message, setMessage] = useState("");

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
            <input
              className="w-full rounded border p-3"
              type="number"
              placeholder="Year"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              required
            />

            <input
              className="w-full rounded border p-3"
              type="text"
              placeholder="Make"
              value={make}
              onChange={(e) => setMake(e.target.value)}
              required
            />

            <input
              className="w-full rounded border p-3"
              type="text"
              placeholder="Model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
            />

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