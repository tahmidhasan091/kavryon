package com.kavryon.platform;

import android.annotation.SuppressLint;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

/**
 * Kavryon Android shell.
 * Injects window.KAVRYON_API_BASE into index.html before scripts run (no race).
 */
public class MainActivity extends AppCompatActivity {
    private WebView webView;
    private BillingBridge billingBridge;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }
        billingBridge = new BillingBridge(this, webView);
        webView.addJavascriptInterface(billingBridge, "KavryonBilling");

        final String apiBase = BuildConfig.API_BASE_URL != null ? BuildConfig.API_BASE_URL : "";
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();

        webView.setWebViewClient(new WebViewClient() {
            // The billing JavaScript bridge is privileged. Never let remote pages
            // navigate into this WebView and gain access to KavryonBilling.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                android.net.Uri uri = request.getUrl();
                return !"https".equalsIgnoreCase(uri.getScheme())
                    || !"appassets.androidplatform.net".equalsIgnoreCase(uri.getHost());
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String path = request.getUrl().getPath();
                if (path != null && path.endsWith("/index.html")) {
                    try {
                        java.io.InputStream in = getAssets().open("public/index.html");
                        byte[] bytes = readAll(in);
                        String html = new String(bytes, StandardCharsets.UTF_8);
                        String inject = "<script>window.KAVRYON_API_BASE=" + org.json.JSONObject.quote(apiBase) + ";</script>";
                        if (html.contains("<head>")) {
                            html = html.replace("<head>", "<head>" + inject);
                        } else {
                            html = inject + html;
                        }
                        return new WebResourceResponse(
                            "text/html", "utf-8",
                            new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8))
                        );
                    } catch (Exception e) {
                        return null;
                    }
                }
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }
        });

        // Load via https://appassets.androidplatform.net for asset loader compatibility
        webView.loadUrl("https://appassets.androidplatform.net/assets/public/index.html");
    }

    private static byte[] readAll(java.io.InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        byte[] b = new byte[4096];
        int n;
        while ((n = in.read(b)) != -1) buf.write(b, 0, n);
        in.close();
        return buf.toByteArray();
    }

    @Override
    protected void onDestroy() {
        if (billingBridge != null) billingBridge.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            webView.evaluateJavascript(
                "(function(){return window.__kavBack && window.__kavBack();})()",
                value -> {
                    if (!"true".equals(value)) {
                        if (webView.canGoBack()) webView.goBack();
                        else MainActivity.super.onBackPressed();
                    }
                }
            );
        } else super.onBackPressed();
    }
}
