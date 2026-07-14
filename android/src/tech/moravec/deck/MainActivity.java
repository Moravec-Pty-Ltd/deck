package tech.moravec.deck;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Thin client for deck: a single WebView pointed at the deck server, for
 * devices that can't install the PWA (e.g. e-ink phones without a capable
 * browser). Everything lives in this one activity; views are built in code so
 * the app needs no resources beyond the launcher icon and no dependencies
 * beyond the platform.
 */
public class MainActivity extends Activity {
	private static final String PREFS = "deck";
	private static final String KEY_URL = "server_url";
	private static final int REQ_FILE_CHOOSER = 1;

	private FrameLayout root;
	private WebView webView;
	private View overlay;
	private ValueCallback<Uri[]> pendingFileChooser;

	@Override
	protected void onCreate(Bundle state) {
		super.onCreate(state);
		root = new FrameLayout(this);
		root.setBackgroundColor(Color.WHITE);
		root.setFitsSystemWindows(true);
		setContentView(root);
		createWebView();

		String url = prefs().getString(KEY_URL, null);
		if (url == null) {
			showSetup(null);
		} else if (state != null) {
			webView.restoreState(state);
			showWeb();
		} else {
			loadServer(url);
		}
	}

	@Override
	protected void onSaveInstanceState(Bundle state) {
		super.onSaveInstanceState(state);
		webView.saveState(state);
	}

	@Override
	public void onBackPressed() {
		if (overlay != null) {
			if (prefs().getString(KEY_URL, null) == null) finish();
			else showWeb();
		} else if (webView.canGoBack()) {
			webView.goBack();
		} else {
			showMenu();
		}
	}

	@Override
	protected void onActivityResult(int requestCode, int resultCode, Intent data) {
		if (requestCode == REQ_FILE_CHOOSER && pendingFileChooser != null) {
			pendingFileChooser.onReceiveValue(
				WebChromeClient.FileChooserParams.parseResult(resultCode, data));
			pendingFileChooser = null;
		} else {
			super.onActivityResult(requestCode, resultCode, data);
		}
	}

	@SuppressLint("SetJavaScriptEnabled")
	private void createWebView() {
		webView = new WebView(this);
		WebSettings s = webView.getSettings();
		s.setJavaScriptEnabled(true);
		s.setDomStorageEnabled(true);
		s.setUseWideViewPort(true);
		s.setLoadWithOverviewMode(true);
		// No stretch/glow at scroll edges: it repaints badly on e-ink.
		webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
		webView.setBackgroundColor(Color.WHITE);
		webView.setWebViewClient(new DeckWebViewClient());
		webView.setWebChromeClient(new DeckChromeClient());
		webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) ->
			openExternally(Uri.parse(url)));
		root.addView(webView, new FrameLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
	}

	private SharedPreferences prefs() {
		return getSharedPreferences(PREFS, MODE_PRIVATE);
	}

	private void loadServer(String url) {
		showWeb();
		webView.loadUrl(url);
	}

	private void showWeb() {
		clearOverlay();
		webView.setVisibility(View.VISIBLE);
	}

	private void showMenu() {
		new AlertDialog.Builder(this)
			.setItems(new CharSequence[] { "Reload", "Change server", "Exit" }, (dialog, which) -> {
				if (which == 0) webView.reload();
				else if (which == 1) showSetup(null);
				else finish();
			})
			.show();
	}

	private void showSetup(String message) {
		clearOverlay();
		webView.setVisibility(View.GONE);

		LinearLayout box = new LinearLayout(this);
		box.setOrientation(LinearLayout.VERTICAL);
		box.setPadding(dp(24), dp(56), dp(24), dp(24));

		TextView title = new TextView(this);
		title.setText("deck");
		title.setTextColor(Color.BLACK);
		title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 34);
		box.addView(title);

		TextView label = new TextView(this);
		label.setText(message != null ? message : "Server URL");
		label.setTextColor(Color.BLACK);
		label.setPadding(0, dp(20), 0, dp(4));
		box.addView(label);

		EditText input = new EditText(this);
		input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
		input.setHint("http://your-mac:4818");
		input.setText(prefs().getString(KEY_URL, ""));
		box.addView(input);

		Button connect = new Button(this);
		connect.setText("Connect");
		connect.setOnClickListener(v -> {
			String url = normalizeUrl(input.getText().toString());
			if (url == null) {
				label.setText("Enter a valid URL, e.g. http://your-mac:4818");
				return;
			}
			prefs().edit().putString(KEY_URL, url).apply();
			loadServer(url);
		});
		LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
			ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
		lp.topMargin = dp(16);
		lp.gravity = Gravity.END;
		box.addView(connect, lp);

		overlay = box;
		root.addView(box, new FrameLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
	}

	private void showError(String description) {
		clearOverlay();
		webView.setVisibility(View.GONE);

		LinearLayout box = new LinearLayout(this);
		box.setOrientation(LinearLayout.VERTICAL);
		box.setGravity(Gravity.CENTER);
		box.setPadding(dp(24), dp(24), dp(24), dp(24));

		TextView msg = new TextView(this);
		msg.setText("Can't reach the deck server.\n" + description);
		msg.setTextColor(Color.BLACK);
		msg.setGravity(Gravity.CENTER);
		box.addView(msg);

		Button retry = new Button(this);
		retry.setText("Retry");
		retry.setOnClickListener(v -> {
			showWeb();
			webView.reload();
		});
		LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
			ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
		lp.topMargin = dp(16);
		lp.gravity = Gravity.CENTER_HORIZONTAL;
		box.addView(retry, lp);

		Button change = new Button(this);
		change.setText("Change server");
		change.setOnClickListener(v -> showSetup(null));
		box.addView(change, lp);

		overlay = box;
		root.addView(box, new FrameLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
	}

	private void clearOverlay() {
		if (overlay != null) {
			root.removeView(overlay);
			overlay = null;
		}
	}

	/** Trims, defaults the scheme to http, and requires a host. */
	static String normalizeUrl(String raw) {
		String url = raw == null ? "" : raw.trim();
		if (url.isEmpty()) return null;
		if (!url.contains("://")) url = "http://" + url;
		Uri uri = Uri.parse(url);
		String scheme = uri.getScheme();
		if (uri.getHost() == null || uri.getHost().isEmpty()) return null;
		if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
		while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
		return url;
	}

	private boolean isServerOrigin(Uri uri) {
		Uri server = Uri.parse(prefs().getString(KEY_URL, ""));
		if (uri.getHost() == null || server.getHost() == null) return false;
		return uri.getHost().equalsIgnoreCase(server.getHost())
			&& portOf(uri) == portOf(server);
	}

	private static int portOf(Uri uri) {
		if (uri.getPort() != -1) return uri.getPort();
		return "https".equals(uri.getScheme()) ? 443 : 80;
	}

	private void openExternally(Uri uri) {
		try {
			startActivity(new Intent(Intent.ACTION_VIEW, uri));
		} catch (Exception ignored) {
			// No handler for this URI; nothing sensible to do.
		}
	}

	private int dp(int value) {
		return Math.round(TypedValue.applyDimension(
			TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
	}

	private class DeckWebViewClient extends WebViewClient {
		@Override
		public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
			Uri uri = request.getUrl();
			String scheme = uri.getScheme();
			boolean isHttp = "http".equals(scheme) || "https".equals(scheme);
			if (isHttp && isServerOrigin(uri)) return false;
			openExternally(uri);
			return true;
		}

		@Override
		public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
			if (request.isForMainFrame()) showError(String.valueOf(error.getDescription()));
		}

		@Override
		public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
			recreate();
			return true;
		}
	}

	private class DeckChromeClient extends WebChromeClient {
		@Override
		public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
				FileChooserParams params) {
			if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
			pendingFileChooser = callback;
			try {
				startActivityForResult(params.createIntent(), REQ_FILE_CHOOSER);
			} catch (Exception e) {
				pendingFileChooser = null;
				return false;
			}
			return true;
		}
	}
}
