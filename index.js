let socket = null
let pc = null
let heartbeat = null

let currentCamera = 'grid'
let carState = {
    latitude: null,
    longitude: null,
}

let map = null
let targetMarker = null
let carMarker = null
let pathLine = null

// HACK: SDP modification to inject VP8/100, required to get video stream from the car
const sdpInjectVP8100 = (input) => {
    let lines = input.split('\r\n');
    // Remove last line if it's empty
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }
    let modified = false;

    // Filter all empty lines
    lines = lines.filter((line) => !line.includes('rtcp-fb:100') && !line.includes('rtpmap:100'));

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // If the line starts with "m=video", modify the SDP
        if (line && line.startsWith('m=video')) {
            const parts = line.split(' ');
            //const modifiedParts = parts.slice(0, 3).concat('100'); // Add "100" to the line
            const modifiedParts = parts;
            lines[i] = modifiedParts.join(' ');
            modified = true;
        }

        // If the line starts with "a=rtpmap" and modification has been made, stop processing
        if (modified && line.startsWith('a=rtpmap')) {
            break;
        }
    }

    // Inject additional attributes if modification was made
    if (modified) {
        const additionalLines = [
            'a=rtpmap:100 VP8/90000',
            'a=rtcp-fb:100 goog-remb',
            'a=rtcp-fb:100 transport-cc',
            'a=rtcp-fb:100 ccm fir',
            'a=rtcp-fb:100 nack',
            'a=rtcp-fb:100 nack pli'
        ];
        lines.push(...additionalLines);
    }

    // Rejoin the lines with "\r\n" and add a trailing "\r\n"
    return lines.join('\r\n') + '\r\n';
};

const connect = (async () => {
    offer = await pc.createOffer({
        offerToReceiveVideo: true
    })
    offer.sdp = sdpInjectVP8100(offer.sdp)
    await pc.setLocalDescription(offer)
    offer = pc.localDescription

    description = JSON.stringify(offer)
    msg = {
        msg_type: 'webcam:signal',
        ctx: 'sentry',
        session_description: offer
    }
    socket.send(JSON.stringify(msg))

})

const switchCamera = (camera) => {
    socket.send(JSON.stringify({
        msg_type: 'webcam:switch',
        camera: camera,
        prevCamera: currentCamera
    }))
    currentCamera = camera
}

const cmdAbort = () => {
    socket.send(JSON.stringify({
        msg_type: 'autopark:cmd_abort'
    }))
    if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
    }
}

const cmdDrive = (action) => {
    socket.send(JSON.stringify({
        msg_type: 'autopark:cmd_' + action,
        latitude: carState.latitude,
        longitude: carState.longitude
    }))
    if (!heartbeat) {
        heartbeat = setInterval(() => {
            socket.send(JSON.stringify({
                msg_type: 'autopark:heartbeat_app',
                timestamp: Date.now()
            }))
            socket.send(JSON.stringify({
                msg_type: 'autopark:device_location',
                latitude: carState.latitude,
                longitude: carState.longitude
            }))
        }, 1000)
    }
}

function convertToLatLngPairs(flatList) {
    const latLngPairs = [];
    for (let i = 0; i < flatList.length; i += 2) {
      latLngPairs.push([flatList[i], flatList[i + 1]]);
    }
    return latLngPairs;
}

function initWebRTC(iceServers) {
    pc = new RTCPeerConnection({
        iceServers: iceServers
    })
    
    pc.onicecandidate = (event) => {
        if (event.candidate && event.candidate.candidate != '') {
            msg = {
                msg_type: 'webcam:signal',
                session_description: event.candidate,
                type: "candidate"
            }
            socket.send(JSON.stringify(msg))
        } else {
            console.error('onicecandidate unknown', event)
        }
    }
    
    pc.addEventListener("track", (e) => {
        const videoElement = document.getElementById('video')
        const stream = new MediaStream();
        stream.addTrack(e.track);
        videoElement.srcObject = stream;
        videoElement.play();
    })
}

// On ready
document.addEventListener("DOMContentLoaded", () => {
    document.getElementById('connectButton').addEventListener('click', connect)
    document.getElementById('disconnectButton').addEventListener('click', () => pc.close())
    document.getElementById('switchGrid').addEventListener('click', () => switchCamera('grid'))
    document.getElementById('switchMain').addEventListener('click', () => switchCamera('main'))
    document.getElementById('switchFront').addEventListener('click', () => switchCamera('front'))
    document.getElementById('switchBack').addEventListener('click', () => switchCamera('back'))

    document.getElementById('cmdAbort').addEventListener('click', cmdAbort)
    document.getElementById('cmdForward').addEventListener('click', () => cmdDrive('forward'))
    document.getElementById('cmdReverse').addEventListener('click', () => cmdDrive('reverse'))
    document.getElementById('cmdFindMe').addEventListener('click', () => cmdDrive('find_me'))

    // Initialize the map
    const map = L.map('map').setView([0, 0], 18); // Default location: London

    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    targetMarker = L.marker([0, 0]).addTo(map);
    carMarker = L.marker([0, 0]).addTo(map);

    pathLine = L.polyline([], {
        color: 'blue', // Line color
        weight: 4, // Line thickness
        opacity: 0.7 // Line opacity
    }).addTo(map);

    map.on('click', function (e) {
        const { lat, lng } = e.latlng;
    
        // Update the car position
        targetMarker.setLatLng([lat, lng]);
    })

    // Get VIN from get parameter
    const urlParams = new URLSearchParams(window.location.search);
    const vin = urlParams.get('vin')
    if (!vin) {
        alert("VIN not found in the URL")
        return
    }

    socket = new WebSocket(`wss://localhost:8443/api/1/vehicles/${vin}/command/stream`)
    socket.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data)
        if ("ice_servers" in msg) {
            // First message from the server
            initWebRTC(msg.ice_servers)
            socket.send(JSON.stringify({"msg_type":"control:ping"}));
            setInterval(() => {
                socket.send(JSON.stringify({"msg_type":"control:ping"}));
            }, msg.ping_frequency / 2)
        } else if (msg.msg_type == "webcam:signal_response") {
            if (msg.type == "answer") {
                pc.setRemoteDescription(msg.session_description)
            } else if (msg.type == "candidate") {
                pc.addIceCandidate(msg.session_description).then(() => {
                    // Candidate added
                }).catch((e) => {
                    console.error("Error adding candidate", e)
                })
            } else {
                console.error("Unknown message type", msg)
            }
        } else if (msg.msg_type == "control:pong") {
            // Ignore pong messages
        } else if (msg.msg_type == "webcam:ready") {
            // Remove the disabled attribute from the connect button
            document.getElementById('connectButton').removeAttribute('disabled')
        } else if (msg.msg_type == "webcam:unavailable") {
            document.getElementById('connectButton').setAttribute('disabled', 'disabled')
        } else if (msg.msg_type == "autopark:smart_summon_viz") {
            pathLine.setLatLngs(convertToLatLngPairs(msg.path))
        } else if (msg.msg_type == "autopark:cmd_result") {
            if (msg.cmd_type.startsWith("autopark:cmd")) {
                if (!msg.result && heartbeat) {
                    clearInterval(heartbeat)
                    heartbeat = null
                }
            }
        } else if (msg.msg_type == "autopark:status") {
            // Loop over all key and values in the message
            for (const [key, value] of Object.entries(msg)) {
                const elem = document.getElementById(key)
                if (elem)
                    elem.textContent = value
            }
        } else if (msg.msg_type == "vehicle_data:location") {
            carState = msg
            carMarker.setLatLng([msg.latitude, msg.longitude])
            map.panTo([msg.latitude, msg.longitude])
    
            // Loop over all key and values in the message
            for (const [key, value] of Object.entries(msg)) {
                const elem = document.getElementById(key)
                if (elem)
                    elem.textContent = value
            }
        } else {
            console.error("Unknown message type", msg)
        }
    })
})
