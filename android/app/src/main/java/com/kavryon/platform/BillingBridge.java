package com.kavryon.platform;

import android.app.Activity;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.annotation.Nullable;
import com.android.billingclient.api.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/**
 * Google Play Billing bridge for WebView.
 * NEVER grants Kavx itself — only returns purchaseToken to JS,
 * which must POST to the backend for server verification.
 *
 * Enable with BuildConfig / product IDs matching server catalog:
 *   kavx_100, kavx_500, kavx_1200, kavx_2500, kavx_5500
 */
public class BillingBridge implements PurchasesUpdatedListener, BillingClientStateListener {
    private final Activity activity;
    private final WebView webView;
    private BillingClient client;
    private boolean ready = false;

    public BillingBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        client = BillingClient.newBuilder(activity)
            .setListener(this)
            .enablePendingPurchases()
            .build();
        client.startConnection(this);
    }

    @Override
    public void onBillingSetupFinished(BillingResult result) {
        ready = result.getResponseCode() == BillingClient.BillingResponseCode.OK;
        evalJs("window.__kavryonBillingReady && window.__kavryonBillingReady(" + ready + ")");
    }

    @Override
    public void onBillingServiceDisconnected() {
        ready = false;
        client.startConnection(this);
    }

    @Override
    public void onPurchasesUpdated(BillingResult result, @Nullable List<Purchase> purchases) {
        try {
            JSONObject out = new JSONObject();
            out.put("responseCode", result.getResponseCode());
            JSONArray arr = new JSONArray();
            if (purchases != null) {
                for (Purchase p : purchases) {
                    JSONObject o = new JSONObject();
                    o.put("purchaseToken", p.getPurchaseToken());
                    o.put("orderId", p.getOrderId());
                    o.put("products", new JSONArray(p.getProducts()));
                    o.put("purchaseState", p.getPurchaseState());
                    o.put("acknowledged", p.isAcknowledged());
                    arr.put(o);
                    // Acknowledge after server verifies — JS will call acknowledgePurchase
                }
            }
            out.put("purchases", arr);
            evalJs("window.__kavryonPurchaseResult && window.__kavryonPurchaseResult(" + out.toString() + ")");
        } catch (Exception e) {
            evalJs("window.__kavryonPurchaseResult && window.__kavryonPurchaseResult({error:'parse'})");
        }
    }

    @JavascriptInterface
    public boolean isReady() {
        return ready;
    }

    @JavascriptInterface
    public void queryProducts(String productIdsCsv) {
        if (!ready) return;
        List<QueryProductDetailsParams.Product> products = new ArrayList<>();
        for (String id : productIdsCsv.split(",")) {
            id = id.trim();
            if (id.isEmpty()) continue;
            products.add(QueryProductDetailsParams.Product.newBuilder()
                .setProductId(id)
                .setProductType(BillingClient.ProductType.INAPP)
                .build());
        }
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
            .setProductList(products)
            .build();
        client.queryProductDetailsAsync(params, (billingResult, detailsList) -> {
            try {
                JSONArray arr = new JSONArray();
                if (detailsList != null) {
                    for (ProductDetails d : detailsList) {
                        JSONObject o = new JSONObject();
                        o.put("productId", d.getProductId());
                        o.put("title", d.getTitle());
                        o.put("description", d.getDescription());
                        ProductDetails.OneTimePurchaseOfferDetails offer = d.getOneTimePurchaseOfferDetails();
                        if (offer != null) {
                            o.put("price", offer.getFormattedPrice());
                            o.put("priceMicros", offer.getPriceAmountMicros());
                            o.put("currency", offer.getPriceCurrencyCode());
                        }
                        arr.put(o);
                    }
                }
                evalJs("window.__kavryonProducts && window.__kavryonProducts(" + arr.toString() + ")");
            } catch (Exception e) {
                evalJs("window.__kavryonProducts && window.__kavryonProducts([])");
            }
        });
    }

    @JavascriptInterface
    public void launchPurchase(String productId) {
        if (!ready || productId == null || productId.isEmpty()) return;
        List<QueryProductDetailsParams.Product> products = new ArrayList<>();
        products.add(QueryProductDetailsParams.Product.newBuilder()
            .setProductId(productId)
            .setProductType(BillingClient.ProductType.INAPP)
            .build());
        client.queryProductDetailsAsync(
            QueryProductDetailsParams.newBuilder().setProductList(products).build(),
            (billingResult, detailsList) -> {
                if (detailsList == null || detailsList.isEmpty()) {
                    evalJs("window.__kavryonPurchaseResult && window.__kavryonPurchaseResult({error:'product_not_found'})");
                    return;
                }
                ProductDetails details = detailsList.get(0);
                List<BillingFlowParams.ProductDetailsParams> paramsList = new ArrayList<>();
                paramsList.add(BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(details)
                    .build());
                BillingFlowParams flow = BillingFlowParams.newBuilder()
                    .setProductDetailsParamsList(paramsList)
                    .build();
                client.launchBillingFlow(activity, flow);
            }
        );
    }

    @JavascriptInterface
    public void acknowledgePurchase(String purchaseToken) {
        if (!ready || purchaseToken == null) return;
        AcknowledgePurchaseParams params = AcknowledgePurchaseParams.newBuilder()
            .setPurchaseToken(purchaseToken)
            .build();
        client.acknowledgePurchase(params, result -> {
            evalJs("window.__kavryonAck && window.__kavryonAck(" + result.getResponseCode() + ")");
        });
    }

    private void evalJs(String script) {
        activity.runOnUiThread(() -> webView.evaluateJavascript(script, null));
    }


    @JavascriptInterface
    public void queryExistingPurchases() {
        if (!ready) return;
        client.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build(),
            (billingResult, purchases) -> {
                try {
                    JSONObject out = new JSONObject();
                    out.put("responseCode", billingResult.getResponseCode());
                    JSONArray arr = new JSONArray();
                    if (purchases != null) {
                        for (Purchase p : purchases) {
                            JSONObject o = new JSONObject();
                            o.put("purchaseToken", p.getPurchaseToken());
                            o.put("orderId", p.getOrderId());
                            o.put("products", new JSONArray(p.getProducts()));
                            o.put("purchaseState", p.getPurchaseState());
                            o.put("acknowledged", p.isAcknowledged());
                            arr.put(o);
                        }
                    }
                    out.put("purchases", arr);
                    evalJs("window.__kavryonExistingPurchases && window.__kavryonExistingPurchases(" + out.toString() + ")");
                } catch (Exception e) {
                    evalJs("window.__kavryonExistingPurchases && window.__kavryonExistingPurchases({purchases:[]})");
                }
            }
        );
    }

    public void destroy() {
        if (client != null) {
            client.endConnection();
            client = null;
        }
    }
}
