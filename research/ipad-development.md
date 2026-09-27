# iPad development and testing options

Research checked September 26, 2026. Context: Windows computer, physical iPad, a 24-hour hackathon with three teammates, and an initial two-hour solo project comparison.

## Recommendation

Build a modular React/TypeScript application around tldraw for the first prototype, test it on the actual iPad in Safari over HTTPS, and keep Capacitor as the route to an installable iPad app. This is an engineering recommendation for the available time and equipment, not a claim that a browser canvas has the same handwriting experience as Apple's native frameworks. The first two hours should validate the central loop: select an area, speak an expression, create a graph, and revise that same graph by voice.

Keep the document model and AI tools independent of the renderer. Store editable objects such as `Stroke`, `Text`, `Latex`, `Plot { expression, domain }`, and `PDFPage`, with stable IDs, transforms, selection, and undoable operations. Then “make it +3” updates a plot's expression rather than replacing a screenshot. That design preserves useful work if the ink surface later moves to native code.

## Platform comparison

| Path | Fit | Work and limits |
| --- | --- | --- |
| React/TypeScript + tldraw, later Capacitor | Best hackathon fit for Windows, desktop mouse testing, and immediate iPad access; permits reuse of web math and PDF components | Capacitor uses WKWebView. An installable package does not automatically improve handwriting, palm rejection, or gesture behavior. iOS builds still need a Mac or a suitable cloud build service and signing. |
| React Native + Expo + Skia | Appropriate when a native cross-platform app is required from the beginning; EAS supports cloud iOS builds from Windows | Skia supplies graphics, not a finished whiteboard. Selection, hit testing, gestures, object editing, and PDF/math integration require separate work. A tldraw web canvas does not directly become a native React Native canvas. |
| SwiftUI/UIKit + PencilKit/PaperKit + PDFKit | Strongest option when iPad handwriting quality is the main priority and a Mac is available | Apple-specific frontend and normal Mac/Xcode development workflow; a Windows desktop interface would be a separate frontend. Check PaperKit API availability against the iPad's OS. |

Sources: [Capacitor iOS](https://capacitorjs.com/docs/ios), [Capacitor environment requirements](https://capacitorjs.com/docs/getting-started/environment-setup), [Expo Windows FAQ](https://docs.expo.dev/faq/), [React Native Skia](https://docs.expo.dev/versions/latest/sdk/skia/), [Skia web support](https://shopify.github.io/react-native-skia/docs/getting-started/web/).

## Testing on the iPad now

1. Serve the application at an HTTPS URL and open it in Safari on the iPad. HTTPS and user permission are required for normal microphone capture; a plain HTTP URL pointing at the Windows laptop is not sufficient. A hosted development preview or HTTPS tunnel avoids depending on the hackathon network allowing direct device-to-laptop traffic. [WebKit media capture requirements](https://webkit.org/blog/7763/a-closer-look-into-webrtc/)
2. Test both Apple Pencil and fingers on the physical device as early as possible. Safari supports Pointer Events for mouse, touch, and stylus, including pressure and tilt where the hardware/browser provide them. Use distinct tool and navigation behavior, such as Pencil drawing and two-finger panning. [WebKit Pointer Events](https://webkit.org/blog/9674/new-webkit-features-in-safari-13/)
3. Verify the actual interactions: draw with a palm resting on the screen; select an area; pinch and pan; move, resize, and rotate an object; use the microphone; save and reopen a document. These are proposed acceptance checks, not results already demonstrated on this iPad.
4. Use desktop mouse input for rapid logic and layout iteration, but do not treat desktop browser device emulation as iPadOS testing. Apple's own simulator runs on a Mac and does not reproduce every physical-device feature or performance characteristic. [Apple simulator/device testing](https://developer.apple.com/documentation/Xcode/running-your-app-on-simulated-or-physical-devices)

Apple Pencil provides force and orientation information, including estimated values and coalesced touch samples. A custom renderer needs deliberate handling; testing only mouse events cannot establish stylus fidelity. [Apple Pencil input](https://developer.apple.com/documentation/uikit/handling-input-from-apple-pencil)

## Downloadable native app routes

- **Capacitor:** retains the web UI and provides bridges to native Swift/Objective-C features. Its local iOS build workflow uses macOS/Xcode; the documentation also identifies cloud build alternatives. Native PencilKit integration is a further engineering project, not a packaging checkbox. [Capacitor iOS](https://capacitorjs.com/docs/ios), [build requirements](https://capacitorjs.com/docs/getting-started/environment-setup)
- **Expo development build:** EAS can build the iOS app in the cloud from Windows and install it on a registered physical device. The documented physical-iOS development-build route requires an active Apple Developer membership. Custom native libraries require an appropriate native build. [Expo iOS setup](https://docs.expo.dev/get-started/set-up-your-environment/?device=physical&mode=development-build&platform=ios), [Expo limitations](https://docs.expo.dev/faq/)
- **Xcode on a Mac:** a free personal Apple Account permits limited personal-device testing. Normal distribution and TestFlight require Apple Developer membership, currently US$99 per year, with regional pricing and some fee-waiver eligibility. [Apple membership comparison](https://developer.apple.com/support/compare-memberships/), [enrollment](https://developer.apple.com/programs/enroll/)
- **TestFlight:** useful after the prototype, but external distribution can require beta review. Do not make an imminent hackathon demonstration depend on that review completing. [Apple TestFlight](https://developer.apple.com/testflight/)

Expo Go availability needs a version check. The September 3, 2026 changelog says SDK 57 is available in the Apple App Store and requires matching Expo-account login in the CLI and the device app. Some other official documentation still describes SDK 54 as the last App Store build. Use the installed compatible runtime or a development build instead of assuming a universal scan-and-run path. [September announcement](https://expo.dev/changelog/expo-go-57-login), [conflicting troubleshooting page](https://docs.expo.dev/troubleshooting/expo-go-version-mismatch/)

## Native components worth revisiting

**PencilKit** supplies low-latency Apple Pencil/finger drawing and a stroke data model. **PaperKit**, built on PencilKit, adds shapes, images, text boxes, editing controls, and persistence. Newer PaperKit APIs expose elements and move/resize/rotate/delete controls; several appear as beta in the fetched documentation, so check SDK and deployment-target support before relying on them. [PencilKit canvas](https://developer.apple.com/documentation/pencilkit/pkcanvasview), [PaperKit](https://developer.apple.com/documentation/paperkit), [PaperKit updates](https://developer.apple.com/documentation/updates/paperkit)

**PDFKit** supports interactive page overlays and Apple explicitly demonstrates PencilKit overlays for writing on PDFs. Export must incorporate overlay content into the PDF; displaying ink above a page does not automatically save that ink into the PDF. [Apple's PDFKit session](https://developer.apple.com/videos/play/wwdc2022/10089/)
