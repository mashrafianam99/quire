package org.quire.editor;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(QuireIntentPlugin.class); // before super.onCreate, so the bridge knows it
        super.onCreate(savedInstanceState);
    }
}
