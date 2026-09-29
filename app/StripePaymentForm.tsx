"use client";

import { FormEvent, useState } from "react";
import {
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";

type StripePaymentFormProps = {
  onSuccess?: () => void;
};

export default function StripePaymentForm({
  onSuccess,
}: StripePaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!stripe || !elements || submitting) {
      return;
    }

    setSubmitting(true);
    setMessage("");

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
    });

    if (error) {
      setMessage(error.message ?? "Payment could not be completed.");
      setSubmitting(false);
      return;
    }

    if (paymentIntent?.status === "succeeded") {
      setMessage("Payment successful.");
      onSuccess?.();
      setSubmitting(false);
      return;
    }

    if (paymentIntent?.status === "processing") {
      setMessage("Payment is processing.");
      setSubmitting(false);
      return;
    }

    setMessage(
      `Payment status: ${paymentIntent?.status ?? "unknown"}`
    );
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-4">
      <PaymentElement />

      <button
        type="submit"
        disabled={!stripe || !elements || submitting}
        className="w-full rounded bg-black px-4 py-3 font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Processing Payment..." : "Pay Securely"}
      </button>

      {message && (
        <p className="text-sm font-medium text-gray-700">{message}</p>
      )}
    </form>
  );
}
