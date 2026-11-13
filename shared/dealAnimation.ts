/** One clock for the public deck and every private receiver. Bottom three are excluded. */
export const DEAL_WARMUP_MS = 480;
export const DEAL_STEP_MS = 32;
export const DEAL_FLIGHT_MS = 460;
export const DEAL_REVEAL_MS = 340;

export function dealCardDelay(index: number, seat: number, seatCount: number): number {
  return DEAL_WARMUP_MS + (index * seatCount + seat) * DEAL_STEP_MS;
}

export function dealTravelDuration(seatCount: number, cardsPerSeat: number): number {
  return dealCardDelay(cardsPerSeat - 1, seatCount - 1, seatCount) + DEAL_FLIGHT_MS;
}

export function dealDuration(seatCount: number, cardsPerSeat: number): number {
  return dealTravelDuration(seatCount, cardsPerSeat) + DEAL_REVEAL_MS;
}
