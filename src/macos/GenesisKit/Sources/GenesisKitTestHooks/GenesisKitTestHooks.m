//
//  GenesisKitTestHooks.m
//  GenesisKit
//
//  Test runs must never take the user's keyboard focus. A test that expands an edge panel or opens the recording
//  picker made the test process the key window, about ten times per suite run (2026-10-25, WindowServer logged
//  "key thief ... (xctest)"). From the moment the test bundle loads, making a window key only orders it front, and
//  the app never activates, so a new test cannot bring it back.
//

#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import "GenesisKitTestHooks.h"

static NSInteger refused = 0;

NSInteger GenesisKitTestHooksRefusedFocus(void) {
    return refused;
}

static void replace(Class cls, SEL selector, IMP replacement) {
    Method method = class_getInstanceMethod(cls, selector);
    if (method) {
        method_setImplementation(method, replacement);
    }
}

static void orderFrontInstead(NSWindow *self, SEL _cmd, id sender) {
    refused += 1;
    [self orderFront:sender];
}

static void noKey(NSWindow *self, SEL _cmd) {
    refused += 1;
}

static void noActivation(NSApplication *self, SEL _cmd) {
    refused += 1;
}

static void noActivationIgnoring(NSApplication *self, SEL _cmd, BOOL flag) {
    refused += 1;
}

__attribute__((constructor)) static void GenesisKitTestHooksInstall(void) {
    replace([NSWindow class], @selector(makeKeyAndOrderFront:), (IMP)orderFrontInstead);
    replace([NSWindow class], @selector(makeKeyWindow), (IMP)noKey);
    replace([NSApplication class], @selector(activateIgnoringOtherApps:), (IMP)noActivationIgnoring);
    replace([NSApplication class], @selector(activate), (IMP)noActivation);
}
