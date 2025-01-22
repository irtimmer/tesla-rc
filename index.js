let socket = null

// On ready
document.addEventListener("DOMContentLoaded", () => {
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
            socket.send(JSON.stringify({"msg_type":"control:ping"}));
            setInterval(() => {
                socket.send(JSON.stringify({"msg_type":"control:ping"}));
            }, msg.ping_frequency / 2)
        } else if (msg.msg_type == "control:pong") {
            // Ignore pong messages
        } else if (msg.msg_type == "autopark:status") {
            // Loop over all key and values in the message
            for (const [key, value] of Object.entries(msg)) {
                const elem = document.getElementById(key)
                if (elem)
                    elem.textContent = value
            }
        } else if (msg.msg_type == "vehicle_data:location") {
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
