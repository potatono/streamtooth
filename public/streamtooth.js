
// Where we are
// Offer and Answer exchange are working for two peers
// Now we need to tee up the next connection
// Add actual logic for peer selection
// We need to think about race conditions for answering offers.  What if two peers try to answer the same one?


// Abtracts PeerConnection and IceCandidates.  Collects IceCandidates until a threshold timeout
// is reached, then triggers a event iceComplete to indicate having a full collection.
class STConnection extends EventTarget {
    static iceServerRestUrl = "https://jplt.metered.live/api/v1/turn/credentials?apiKey=859b39cc0d353464345498af68d84df33fd5";
    static iceServers;

    // Connection Id of this connection, currently the id in firestore
    conId;

    // Reference to firestore doc
    doc;

    // PeerConnection
    #pc;

    // IceCandidates
    #ice;

    // Timer
    #timer;

    // Type
    type;

    // Flag for whether we've sent iceComplete 
    // (some browsers take a long time to send the final null iceCandidate)
    #iceCompleteDispatched = false;

    // Id of the remote peer
    remotePeerId;

    constructor() { 
        super();
    }

    get localDescription() {
        return this.#pc.localDescription;
    }

    get connectionState() {
        return this.#pc.connectionState;
    }

    async getIceServers() {
        if (!STConnection.iceServers) {
            const response = await fetch(STConnection.iceServerRestUrl);
            STConnection.iceServers = await response.json();    
        }

        return STConnection.iceServers;
    }

    async setup() {
        const iceServers = await this.getIceServers();
        this.remotePeerId = null;
        this.#iceCompleteDispatched = false;
        this.#pc = new RTCPeerConnection({ 'iceServers': iceServers });
        this.#ice = [];

        console.log("Adding event listeners");
        this.#pc.addEventListener("icecandidate", (ev) => { this.registerCandidate(ev.candidate); });
        this.#pc.addEventListener("track", (ev) => { this.dispatchTrack(ev); });
        this.#pc.addEventListener("connectionstatechange", (ev) => {this.dispatchStateChange(ev); });
    }

    // When IceCandidates come in we start/restart a timer, when the timer goes off
    // we assume no more candidates are coming and fire the iceComplete pseudo-event
    registerCandidate(candidate) {
        //console.log("Got ice candidate..");
        this.#ice.push(candidate);

        if (this.#timer)
            clearTimeout(this.#timer);

        // TODO Don't love this
        const fireEvent = () => { 
            if (!this.#iceCompleteDispatched) {
                this.#iceCompleteDispatched = true;
                console.log("Dispatching iceComplete");
                this.dispatchEvent(new CustomEvent("iceComplete", { "detail": { 
                    "ice": this.#ice, 
                    "desc": this.#pc.localDescription,
                    "pc": this.#pc, 
                    "stc": this 
                }}));
            }
        };

        // If we have an empty candidate then that signals end of candidates
        if (!candidate) {
            console.log("ICE Candidate was null, firing complete");
            fireEvent();
        }
        else {
            // Otherwise wait for a full second of silence
            this.#timer = setTimeout(fireEvent, 1000);
        }
    }

    dispatchTrack(ev) {
        this.dispatchEvent(new CustomEvent("track", { "detail": ev })); 
    }

    dispatchStateChange(ev) {
        this.dispatchEvent(new CustomEvent("stateChange", { "detail": ev}));
    }

    getConnectionInfo() {
        return {
            "desc": this.#pc.localDescription,
            "ice": this.#ice
        }
    }

    async createOffer(stream) {
        // TODO Check if pc already has local description.  We should never createOffer twice?

        this.type = "offer";

        if (stream) {
            for (var track of stream.getTracks()) {
                this.#pc.addTrack(track, stream);
            }
        }
        
        var offer = await this.#pc.createOffer();
        await this.#pc.setLocalDescription(offer);
        
        return offer;
    }

    async createWhepOffer() {
        this.type = "whep_offer";

        this.#pc.addTransceiver('video',{'direction':'sendrecv'});
        this.#pc.addTransceiver('audio',{'direction':'sendrecv'});

        var offer = await this.#pc.createOffer();

        await this.#pc.setLocalDescription(offer);
        
        return offer;
    }

    async createAnswer(offer) {
        this.type = "answer";

        var answer = await this.#pc.createAnswer();
        await this.#pc.setLocalDescription(answer);

        return answer;
    }

    async connectRemote(msg) {
        await this.#pc.setRemoteDescription(msg.desc);

        for (var ice of msg.ice) {
            this.#pc.addIceCandidate(ice);
        }
    }
}

class STPeerCriteria {
    static MAX_LOCATION_ACCURACY = 3000; // 3 km Maximum Location Accuracy
    static RADIUS_EARTH = 6371.0;
    static DISTANCE_SCORE = 1;  // 1 per m
    static LOAD_SCORE = 50000;  // 50k per connection
    static ISP_SCORE = -100000; // -100k if same isp
    
    /**
     * location: approximated location
     * isp: guess at the isp
     * load: number of established connections
     */

    location = null;
    isp = null;
    load = 0;

    constructor(data) {
        if (data) {
            this.location = data.location;
            this.isp = data.isp;
            this.load = data.load;
        }
        else { 
            this.initLocation();
            this.initServiceProvider();    
        }
    }

    get data() {
        return { "load": this.load, "isp": this.isp, "location": this.location };
    }

    rad(deg) {
        return deg * (Math.PI/180);
    }

    deg(rad) {
        return rad * (180 / Math.PI);
    }

    // https://stackoverflow.com/questions/7222382/get-lat-long-given-current-point-distance-and-bearing
    getLocationAtDistance(coords, dist, bearing) {
        var lat = coords.latitude;
        var lon = coords.longitude;

        // Radius of earth
        let R = STPeerCriteria.RADIUS_EARTH;

        // Convert to radians
        lat = this.rad(lat);
        lon = this.rad(lon);
        bearing = this.rad(bearing);

        // Distance is in km convert from m.
        dist = dist / 1000;

        // Compute new lat/lon
        var newlat = Math.asin(
            Math.sin(lat) * Math.cos(dist/R) + 
            Math.cos(lat) * Math.sin(dist/R) * 
            Math.cos(bearing)
        );
        var newlon = lon + Math.atan2(
            Math.sin(bearing) * Math.sin(dist/R) * Math.cos(lat),
            Math.cos(dist/R) - Math.sin(lat) * Math.sin(newlat)
        );

        // Convert back to degrees
        newlat = this.deg(newlat);
        newlon = this.deg(newlon);

        return { latitude: newlat, longitude: newlon, accuracy: coords.accuracy };
    }

    reduceAccuracy(coords) {
        if (coords.accuracy < STPeerCriteria.MAX_LOCATION_ACCURACY) {
            var distance = STPeerCriteria.MAX_LOCATION_ACCURACY - coords.accuracy;
            var bearing = Math.random() * 360;
            var newcoords = this.getLocationAtDistance(coords, distance, bearing);
            newcoords.accuracy += distance;

            console.log("Reduced accuracy of", coords.accuracy, "m to", newcoords.accuracy + "m.");

            return newcoords;
        }

        // When we serialize later it needs to be a plain object, not a GeolocationCoordinates object
        // So just go ahead and copy the values now.
        return { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy };
    }

    initLocation() {
        navigator.geolocation.getCurrentPosition(
            (loc) => { this.location = this.reduceAccuracy(loc.coords) },
            (err) => { 
                console.log("Could not get location data.", err); 
                this.location = { latitude: 0.0, longitude: 0.0, accuracy: 1000000 }    
            }
        )
    }

    distanceTo(criteria) {
        let R = STPeerCriteria.RADIUS_EARTH;
        let coords = criteria.location;
      
        var lat1 = this.rad(this.location.latitude);
        var lat2 = this.rad(coords.latitude);
        var dLat = this.rad(coords.latitude-this.location.latitude);
        var dLon = this.rad(coords.longitude-this.location.longitude);
            
        var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.sin(dLon/2) * Math.sin(dLon/2) * Math.cos(lat1) * Math.cos(lat2); 
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
      
        return R * c * 1000;
    }

    async initServiceProvider() {
        var response = await fetch("https://ipinfo.io/json");
        var data = await response.json();
        console.log(data);
        this.isp = data['org'];

        // If Geolocation API fails use this as a backup.
        if (this.location == null || (this.location.latitude == 0 && 
            this.location.longitude == 0)) 
        {
            console.log("Falling back to location data from ipinfo.");
            var loc = data['loc'].split(",").map(Number);
            this.location = { latitude: loc[0], longitude: loc[1], accuracy: 10000 };
        }
    }

    static compareTo(data1, data2) {
        var c1 = new STPeerCriteria(data1);
        var c2 = new STPeerCriteria(data2);

        var d = c1.distanceTo(c2);

        var v1 = (
            c1.load * STPeerCriteria.LOAD_SCORE + 
            d * STPeerCriteria.DISTANCE_SCORE + 
            (c1.isp == c2.isp) * STPeerCriteria.ISP_SCORE
        );

        var v2 = (
            c2.load * STPeerCriteria.LOAD_SCORE +
            d * STPeerCriteria.DISTANCE_SCORE +
            (c1.isp == c2.isp) * STPeerCriteria.ISP_SCORE
        );
        
        console.log("v1=",v1,"v2=",v2);
        return v1 - v2;
    }
}

class STPeers extends EventTarget {
    /** Data Model
     * type: One of "offer" or "answer"
     * status: One of "available", "pending", "established", "closed"
     * desc: Peer localDescription of offer or answer
     * ice: Array of ice candidates
     * from: peerId of the sender
     * to: peerId of the receipient (answers only)
     */

    // Firestore
    #db;

    // Key of the stream peers are connected to
    #channel;

    // The unique identifier of this peer
    //#peerId;

    #hasDispatchedInit = false;

    #connections = [];

    #criteria;

    #stopListening;

    #blacklisted = {};

    constructor(db, channel) {
        super();

        this.#db = db;
        this.#channel = channel;
        //this.#peerId = window.crypto.randomUUID();
        this.#criteria = new STPeerCriteria();
    }

    get ref() {
        return this.#db.collection("channels")
            .doc(this.#channel).collection("peers");
    }

    get peerId() {
        return firebase.auth().currentUser.uid;
        //return this.#peerId;
    }

    async clear() {
        var docs = await this.ref.get()
        docs.forEach(async doc => { await doc.ref.delete(); })
    }

    listen() {
        this.#stopListening = this.ref.onSnapshot((snapshot) => {
            if (this.#hasDispatchedInit) {
                var answers = this.filterAnswers(snapshot.docChanges());
                if (answers.length > 0)
                    this.dispatchEvent(new CustomEvent("answer", { "detail" : { "answers": answers }}));

                var whep_answers = this.filterWhepAnswers(snapshot.docChanges());
                if (whep_answers.length > 0)
                    this.dispatchEvent(new CustomEvent("whep_answer", { "detail": { "whep_answers": whep_answers }}));
            }
            else {
                this.#hasDispatchedInit = true;
                var offers = this.filterOffers(snapshot.docs);
                console.log("Dispatching init event with", offers);
                this.dispatchEvent(new CustomEvent("init", { "detail": { "offers": offers }}));
            }
        });
    }

    reload() {
        this.#stopListening();
        this.#hasDispatchedInit = false;
        this.listen();
    }

    filterOffers(docs) {
        var result = [];

        docs.forEach((doc) => {
            var data = doc.data();

            if (data['type'] == "offer" && 
                data['status'] == "available" && 
                data['from'] != this.peerId && // Don't answer dangling offers from self after reload
                !(data['from'] in this.#blacklisted) // Don't reconnect to people who have disconnected us
            ) {
                data['ice'] = JSON.parse(data['ice']);
                data['desc'] = JSON.parse(data['desc']);
                result.push(data); 
            }
        })

        return result;
    }

    filterAnswers(changes) {
        var result = [];

        changes.forEach((change) => {
            if (change.type == "added") {
                var data = change.doc.data();

                if (data['type'] == "answer" && data['to'] == this.peerId) {
                    data['ice'] = JSON.parse(data['ice']);
                    data['desc'] = JSON.parse(data['desc']);
                    result.push(data);
                }
            }
        })

        return result;
    }

    filterWhepAnswers(changes) {
        var result = [];

        changes.forEach((change) => {
            if (change.type == "added") {
                var data = change.doc.data();

                if (data['type'] == "whep_answer" && data['to'] == this.peerId) {
                    data['desc'] = JSON.parse(data['desc']);

                    // MediaMTX will return the ice candidates with the answer
                    // but just in case it's in there lets decode it
                    if (data['ice'])
                        data['ice'] = JSON.parse(data['ice']);
                    else
                        data['ice'] = [];

                    result.push(data);
                }
            }
        })

        return result;
    }

    async send(msgType, desc, ice, to) {
        var msg = {
            "timestamp": firebase.firestore.Timestamp.now(), 
            "type": msgType,
            "from": this.peerId,
            "status": "available",
            "desc": JSON.stringify(desc),
            "ice": JSON.stringify(ice),
            "criteria": this.#criteria.data
        };

        if (to) 
            msg['to'] = to;

        console.log("Sending", msg["type"], "from" , msg['from']);

        var doc = await this.ref.add(msg);
        
        return doc;
    }

    async update(docId, state) {
        return await this.ref.doc(docId).update({ 
            "timestamp": firebase.firestore.Timestamp.now(),
            "status": state 
        });
    }

    addConnection(msg) {
        this.#connections.push(msg);
        this.#criteria.load = this.#connections.length;
    }

    getLastConnectionPeerId() {
        if (this.#connections.length > 0)
            return this.#connections[this.#connections.length-1]['from']

        return null;
    }

    blacklist(peerId) {
        this.#blacklisted[peerId] = true;
    }
}

class StreamTooth extends EventTarget {
    
    // Peers
    #peers = null;

    // Inbound STConnection
    #in = null;
    
    // Pending Outbound STConnection
    #out = null;

    // Established Outbound STConnections
    #outs = [];

    // Local stream
    #stream = null;

    // Video element for display
    #element = null;

    #pendingOffer = null;

    constructor(db, channel, element) {
        super();
        this.#peers = new STPeers(db, channel);
        this.#element = element;
    }

    // Getter/Setter for stream.  If set and <video> defined then attach to video
    get stream() { return this.#stream };
    set stream(val) { 
        console.log("Updating stream to", val);
        
        this.#stream = val;
        
        if (this.#element) {
            console.log(this.#element);
            this.#element.srcObject = this.#stream;
            console.log(this.#element);
        }
    }

    get peerId() { return this.#peers.peerId; }

    async clear() {
        await this.#peers.clear();
    }

    async cleanup() {
        console.log("cleanup");

        for (var d of this.#outs)
            await d.doc.delete();

        if (this.#in && this.#in.doc)
            await this.#in.doc.delete();

    }
    
    // Starts local stream from camera/microphone
    async startInputMedia() {
        var constraints = { audio:true, video:true };
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);

        this.#peers.addEventListener("answer", (ev) => { this.connectPeerAnswer(ev.detail.answers); })
        this.#peers.listen();

        this.startNextOutputConnection();

        return this.stream;
    }

    // Starts local stream from PeerConnection
    async startInputConnection() {
        this.#in = new STConnection();

        this.#in.addEventListener("iceComplete", (ev) => { this.sendPeerInfo(ev); });
        this.#in.addEventListener("track", (ev) => { 
            this.stream = ev.detail.streams[0]; 
            console.log(ev.detail.streams);
        });
        this.#in.addEventListener("stateChange", (ev) => { this.updateConnectionState(this.#in, ev); });

        await this.#in.setup();

        this.#peers.addEventListener("init", (ev) => { this.initInputOffer(ev.detail.offers) });
        this.#peers.addEventListener("answer", (ev) => { this.connectPeerAnswer(ev.detail.answers); })
        this.#peers.addEventListener("whep_answer", (ev) => { this.connectWhepAnswer(ev.detail.whep_answers); })
        this.#peers.listen();

        window.addEventListener("beforeunload", (ev) => { this.cleanup(ev); });

        return this.#in;
    }

    async startNextOutputConnection() {
        console.log("Starting next output connection..");

        this.#out = new STConnection();
        this.#out.addEventListener("iceComplete", (ev) => { this.sendPeerInfo(ev); });
        this.#out.addEventListener("stateChange", (ev) => { this.updateConnectionState(this.#out, ev); });
        
        await this.#out.setup();
        await this.#out.createOffer(this.stream);

        this.#outs.push(this.#out);
    }

    /**
     * Initializes the input by selecting a peer offer to answer, or by creating a WHEP offer if there are
     * none.
     * @param {} offers 
     */
    async initInputOffer(offers) {
        if (!offers || !offers.length) {
            console.log("No offers available, creating a WHEP offer..");
            this.#in.createWhepOffer();
        }
        else {
            this.selectPeerOffer(offers);
        }
    }

    async selectPeerOffer(offers) {
        offers.sort((a,b) => STPeerCriteria.compareTo(a['criteria'], b['criteria']));

        for (var offer of offers) {
            this.#pendingOffer = offer;
            await this.#in.connectRemote(offer);
            this.#peers.addConnection(offer);
            return await this.#in.createAnswer(offer);
        }
    }

    async connectPeerAnswer(answers) {
        answers.sort((a,b) => STPeerCriteria.compareTo(a['criteria'], b['criteria']));
        
        console.log("connectPeerAnswer", answers);
        for (var answer of answers) {
            console.log("Connecting peer answer", answer);
            this.#peers.addConnection(answer);
            return await this.#out.connectRemote(answer);
        }
    }

    async connectWhepAnswer(answers) {
        // There should only ever be one answer since it is from the origin..

        console.log("connectWhepAnswer", answers);
        for (var answer of answers) {
            console.log("Connecting whep answer", answer);
            this.#peers.addConnection(answer);

            await this.#in.connectRemote(answer);
            
            return true;
        }

        return false;
    }

   async sendPeerInfo(ev) {
        // We receive a complete list of iceCandidates when creating an offer or answer
        // We need to vary the message depending on whether this event was triggered
        // by an inbound or outbound connection.
        var stc = ev.detail.stc;

        // STConnection has type of offer, answer, whep_offer, whep_answer..
        var msgType = stc.type;

        var to = this.#pendingOffer && this.#pendingOffer.from;

        console.log("Sending message for", msgType);

        var doc = await this.#peers.send(msgType, ev.detail.desc, ev.detail.ice, to);
        stc.conId = doc.id;
        stc.doc = doc;
    }

    async updateConnectionState(stc, ev) {
        var newState = stc.connectionState;
        console.log("New connection state:", newState);

        if (stc.conId) {
            await this.#peers.update(stc.conId, newState);

            if (newState == "connected") {
                var peerId = this.#peers.getLastConnectionPeerId();
                stc.remotePeerId = peerId;
                this.dispatchEvent(new CustomEvent("peerConnected", { "detail": { "peerId": peerId }}));

                console.log("Creating a new output connection for the next peer.");
                this.startNextOutputConnection();
            }
        }

        if (stc == this.#in && (newState == "disconnected" || newState == "failed")) {
            console.log("Input peer disconnected, re-establishing input connection");

            this.#peers.blacklist(this.#in.remotePeerId);
            this.#in.setup();
            this.#peers.reload();
        }
    }
}