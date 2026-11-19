// The app bar's notification control and inbox count, shared with the phone
// session menu: on a phone the session page hides the app bar and offers the
// same controls from its own menu. The layout owns the logic and keeps this in step.
class AppChrome {
	pushSupported = $state(false);
	pushDenied = $state(false);
	subscribed = $state(false);
	pushBusy = $state(false);
	inboxCount = $state(0);
	togglePush: () => void = () => {};
}

export const appChrome = new AppChrome();
