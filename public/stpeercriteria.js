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
            //this.initLocation();
            //this.initServiceProvider();    
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