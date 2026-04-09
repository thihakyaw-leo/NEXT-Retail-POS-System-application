export function formatCents(value: number, currencyCode = 'USD', locale = 'en-US') {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: currencyCode,
		maximumFractionDigits: 2
	}).format(value / 100);
}
