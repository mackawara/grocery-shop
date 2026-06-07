// Minimal ambient types for the untyped `paynow` package (v2.x).
declare module 'paynow' {
  export class Payment {
    add(name: string, amount: number): Payment;
    total(): number;
  }

  export class InitResponse {
    status: string;
    success: boolean;
    error?: string;
    pollUrl?: string;
    redirectUrl?: string;
    instructions?: string;
  }

  export class StatusResponse {
    status: string;
    reference?: string;
    amount?: string;
    paynowReference?: string;
    pollUrl?: string;
    error?: string;
  }

  export class Paynow {
    constructor(
      integrationId: string,
      integrationKey: string,
      resultUrl?: string,
      returnUrl?: string,
    );
    resultUrl: string;
    returnUrl: string;
    createPayment(reference: string, authEmail?: string): Payment;
    send(payment: Payment): Promise<InitResponse>;
    sendMobile(payment: Payment, phone: string, method: string): Promise<InitResponse>;
    pollTransaction(pollUrl: string): Promise<StatusResponse>;
    // Throws if the callback hash does not match.
    parseStatusUpdate(rawBody: string): StatusResponse;
  }
}
