/**
 * Wikipedia has standalone articles whose title is a calendar year or a
 * month/day (for example, "1969", "2024", or "January 1"). Keep the
 * predicates deliberately narrow so titles such as "2024 in music" remain
 * available to explore.
 */
export function isYearArticle(title: string): boolean {
  return /^\d{4}$/.test(title.trim())
}

const MONTH_NAMES = '(?:January|February|March|April|May|June|July|August|September|October|November|December)'

export function isDayArticle(title: string): boolean {
  const normalized = title.trim()
  return new RegExp(`^${MONTH_NAMES} (?:[1-9]|[12]\\d|3[01])$`).test(normalized)
    || new RegExp(`^(?:[1-9]|[12]\\d|3[01]) ${MONTH_NAMES}$`).test(normalized)
}

export function isYearOrDayArticle(title: string): boolean {
  return isYearArticle(title) || isDayArticle(title)
}
